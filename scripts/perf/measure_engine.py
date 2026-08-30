#!/usr/bin/env python3
"""Measure the engine daemon's resident cost at idle, under load, and after.

Written for `.github/workflows/perf-measure.yml` (issue #1162), which runs it on
a Windows, a macOS and a Linux runner. The 2026-08-30 sweep (#1143) could only
measure Linux, so every per-platform magnitude in that program's sub-issues is
code-derived; this script is the thing that turns them into numbers.

It is one Python file rather than three shell legs on purpose. The sampling is
the only genuinely per-OS part - /proc on Linux, `ps` on macOS, PowerShell's
`Get-Process` on Windows - and everything around it (start the engine, wait for
/health, drive a run over HTTP, aggregate) is identical everywhere. Three copies
of that in bash/bash/pwsh would be three things to keep in step and none of them
runnable on a developer's machine.

Method mirrors the sweep's, so the numbers are comparable to the Linux baselines
recorded in #1143: the engine is spawned with the same `--verbose 1` the app's
sidecar uses (`app/electron/sidecar.ts`), idle is sampled for 60s, the load phase
is one 8-VU constant_concurrency run against `scripts/test/mock-server.go`, and
the post-run phase watches what a completed run keeps hold of (#1154).

Stdlib only - the runners have no third-party Python and this must not need pip.

Usage:
    python scripts/perf/measure_engine.py \
        --engine engine/build-release/vayu-engine \
        --mock ./mock-server \
        --out perf-engine.json
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

# A sample is cheap, so the intervals are the sweep's rather than the finest the
# machine allows: 5s at idle (nothing moves), 2s under load (the ramp does).
IDLE_INTERVAL_S = 5.0
LOAD_INTERVAL_S = 2.0
RETENTION_INTERVAL_S = 5.0

# How long to wait for /health after spawning. The engine runs orphan
# reconciliation, inbox cleanup and the page-reclaim rewrite before it listens,
# and #1144 prices that at up to 45s on a cold data dir; 90s is a runaway guard.
HEALTH_TIMEOUT_S = 90.0

# Grace beyond the requested run duration before a run is called stuck.
RUN_GRACE_S = 90.0

TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "stopped"})


@dataclass
class Sample:
    """One observation of the engine process."""

    phase: str
    elapsed_s: float
    rss_bytes: int
    threads: int
    cpu_seconds: float

    def to_json(self) -> dict:
        return {
            "phase": self.phase,
            "elapsedSeconds": self.elapsed_s,
            "rssBytes": self.rss_bytes,
            "threads": self.threads,
            "cpuSeconds": self.cpu_seconds,
        }


@dataclass
class PhaseStats:
    """What a phase's samples add up to. Consumed by scripts/perf/summarize.py."""

    samples: int
    seconds: float
    rss_min_bytes: int
    rss_max_bytes: int
    rss_last_bytes: int
    threads_min: int
    threads_max: int
    threads_last: int
    cpu_percent_of_one_core: Optional[float]

    def to_json(self) -> dict:
        """camelCase, because the rest of the artifact and the engine's own
        report are camelCase - the dataclass stays PEP 8 on the Python side."""
        return {
            "samples": self.samples,
            "seconds": self.seconds,
            "rssMinBytes": self.rss_min_bytes,
            "rssMaxBytes": self.rss_max_bytes,
            "rssLastBytes": self.rss_last_bytes,
            "threadsMin": self.threads_min,
            "threadsMax": self.threads_max,
            "threadsLast": self.threads_last,
            "cpuPercentOfOneCore": self.cpu_percent_of_one_core,
        }


class MeasurementError(RuntimeError):
    """A failure that makes the measurement meaningless rather than merely odd."""


# --------------------------------------------------------------------------
# Per-OS sampling. Each backend returns (rss_bytes, threads, cpu_seconds) for a
# live pid and raises MeasurementError when the process is gone - a process that
# died mid-phase invalidates the phase, so it must not be swallowed.
# --------------------------------------------------------------------------


def _sample_linux(pid: int) -> tuple[int, int, float]:
    """Read /proc/<pid>/stat. No spawn, so sampling perturbs nothing."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise MeasurementError(f"engine pid {pid} is gone: {exc}") from exc

    # comm (field 2) is parenthesised and may itself contain spaces and ')',
    # so fields are counted from after the last ')' rather than by splitting.
    close = raw.rfind(")")
    if close < 0:
        raise MeasurementError(f"unparseable /proc/{pid}/stat")
    fields = raw[close + 2 :].split()

    # Offsets are from `man 5 proc`, minus the 3 fields consumed above.
    utime, stime = int(fields[11]), int(fields[12])
    num_threads = int(fields[17])
    rss_pages = int(fields[21])

    ticks = os.sysconf("SC_CLK_TCK")
    page_size = os.sysconf("SC_PAGE_SIZE")
    return rss_pages * page_size, num_threads, (utime + stime) / ticks


def _parse_ps_cpu_time(value: str) -> float:
    """Parse ps's cumulative CPU time: [[dd-]hh:]mm:ss[.ss]."""
    days = 0.0
    if "-" in value:
        day_part, _, value = value.partition("-")
        days = float(day_part)

    parts = [float(p) for p in value.split(":")]
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60.0 + part
    return days * 86400.0 + seconds


def _sample_darwin(pid: int) -> tuple[int, int, float]:
    """`ps` for RSS and CPU time, `ps -M` for the thread count macOS ps has no
    column for (there is no `nlwp` outside Linux)."""
    proc = subprocess.run(
        ["ps", "-o", "rss=,time=", "-p", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    line = proc.stdout.strip()
    if proc.returncode != 0 or not line:
        raise MeasurementError(f"engine pid {pid} is gone (ps rc={proc.returncode})")
    rss_kb, _, cpu_time = line.split(None, 1)

    threads_proc = subprocess.run(
        ["ps", "-M", "-p", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    # One header line, then one line per thread.
    thread_lines = [ln for ln in threads_proc.stdout.splitlines() if ln.strip()]
    threads = max(len(thread_lines) - 1, 0)

    return int(rss_kb) * 1024, threads, _parse_ps_cpu_time(cpu_time.strip())


def _powershell() -> str:
    exe = shutil.which("pwsh") or shutil.which("powershell")
    if not exe:
        raise MeasurementError("neither pwsh nor powershell is on PATH")
    return exe


def _sample_windows(pid: int) -> tuple[int, int, float]:
    """PowerShell `Get-Process`, one spawn per sample.

    A spawn every 2s is itself load, which is exactly the cost #1148 is about -
    but at 0.5 Hz against a 12k-RPS run it is noise, and the alternative (a
    long-lived sampler process streaming JSON lines) buys precision this
    measurement does not need at the price of a second lifecycle to manage.
    """
    script = (
        f"$p = Get-Process -Id {pid} -ErrorAction Stop; "
        "[pscustomobject]@{ rss = $p.WorkingSet64; threads = $p.Threads.Count; "
        "cpu = $p.TotalProcessorTime.TotalSeconds } | ConvertTo-Json -Compress"
    )
    proc = subprocess.run(
        [_powershell(), "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise MeasurementError(f"engine pid {pid} is gone: {proc.stderr.strip()}")

    payload = json.loads(proc.stdout)
    return int(payload["rss"]), int(payload["threads"]), float(payload["cpu"])


def resolve_sampler() -> Callable[[int], tuple[int, int, float]]:
    if sys.platform.startswith("linux"):
        return _sample_linux
    if sys.platform == "darwin":
        return _sample_darwin
    if os.name == "nt":
        return _sample_windows
    raise MeasurementError(f"no sampler for platform {sys.platform!r}")


# --------------------------------------------------------------------------
# HTTP against the engine
# --------------------------------------------------------------------------


def http_json(url: str, body: Optional[dict] = None, timeout: float = 15.0) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        return json.loads(response.read().decode("utf-8"))


def wait_for_health(base_url: str, deadline_s: float) -> dict:
    """Poll /health until it answers. Returns the health payload."""
    started = time.monotonic()
    last_error = "no attempt made"
    while time.monotonic() - started < deadline_s:
        try:
            return http_json(f"{base_url}/health", timeout=5.0)
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            last_error = str(exc)
            time.sleep(0.25)
    raise MeasurementError(
        f"engine did not answer /health within {deadline_s:.0f}s: {last_error}"
    )


def start_run(base_url: str, target_url: str, vus: int, duration_s: int) -> str:
    """POST /runs and return the run id.

    `constant_concurrency` is the spelling `parse_load_test_type` actually
    recognises (engine/include/vayu/types.hpp). The two checked-in fixtures under
    scripts/test/ say `"constant"`, which parses to nullopt and only works
    because the strategy defaults to constant - not a spelling to copy.
    """
    payload = {
        "method": "GET",
        "url": target_url,
        "headers": {},
        "mode": "constant_concurrency",
        "concurrency": vus,
        "duration": f"{duration_s}s",
    }
    response = http_json(f"{base_url}/runs", body=payload)
    run_id = response.get("runId")
    if not run_id:
        raise MeasurementError(f"POST /runs returned no runId: {response}")
    return run_id


def run_status(base_url: str, run_id: str) -> str:
    return str(http_json(f"{base_url}/runs/{run_id}").get("status", "unknown"))


# --------------------------------------------------------------------------
# Phases
# --------------------------------------------------------------------------


@dataclass
class Recorder:
    """Collects samples and knows when the process stopped answering."""

    sampler: Callable[[int], tuple[int, int, float]]
    pid: int
    origin: float = field(default_factory=time.monotonic)
    samples: list[Sample] = field(default_factory=list)

    def take(self, phase: str) -> Sample:
        rss, threads, cpu = self.sampler(self.pid)
        sample = Sample(
            phase=phase,
            elapsed_s=round(time.monotonic() - self.origin, 3),
            rss_bytes=rss,
            threads=threads,
            cpu_seconds=cpu,
        )
        self.samples.append(sample)
        return sample

    def phase_samples(self, phase: str) -> list[Sample]:
        return [s for s in self.samples if s.phase == phase]


def sample_for(
    recorder: Recorder,
    phase: str,
    seconds: float,
    interval: float,
    until: Optional[Callable[[], bool]] = None,
) -> None:
    """Sample `phase` for `seconds`, stopping early when `until()` is true.

    `until` is polled on the sampling interval rather than in a tighter loop of
    its own: the run-status poll is an HTTP request to the process being
    measured, and a busy one would be measuring itself.
    """
    started = time.monotonic()
    recorder.take(phase)
    while time.monotonic() - started < seconds:
        time.sleep(interval)
        recorder.take(phase)
        if until is not None and until():
            return


def summarize(samples: list[Sample]) -> PhaseStats:
    """Aggregate one phase. CPU is a delta over the phase, not an instant."""
    if not samples:
        raise MeasurementError("cannot summarize a phase with no samples")

    span = samples[-1].elapsed_s - samples[0].elapsed_s
    cpu_delta = samples[-1].cpu_seconds - samples[0].cpu_seconds
    cpu_percent = round(cpu_delta / span * 100.0, 3) if span > 0 else None

    return PhaseStats(
        samples=len(samples),
        seconds=round(span, 3),
        rss_min_bytes=min(s.rss_bytes for s in samples),
        rss_max_bytes=max(s.rss_bytes for s in samples),
        rss_last_bytes=samples[-1].rss_bytes,
        threads_min=min(s.threads for s in samples),
        threads_max=max(s.threads for s in samples),
        threads_last=samples[-1].threads,
        cpu_percent_of_one_core=cpu_percent,
    )


def directory_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


# --------------------------------------------------------------------------
# Process lifecycle
# --------------------------------------------------------------------------


def spawn(command: list[str], log_path: Path) -> subprocess.Popen:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handle = log_path.open("w", encoding="utf-8")
    return subprocess.Popen(command, stdout=handle, stderr=subprocess.STDOUT)


def terminate(process: Optional[subprocess.Popen], name: str) -> None:
    """Ask, then insist. A leaked child fails the runner's job cleanup, not this
    script, so it is worth being thorough about."""
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
        return
    except subprocess.TimeoutExpired:
        print(f"[perf] {name} ignored terminate, killing", file=sys.stderr)
    process.kill()
    process.wait(timeout=15)


def measure(args: argparse.Namespace) -> dict:
    base_url = f"http://127.0.0.1:{args.port}"
    target_url = f"http://127.0.0.1:{args.mock_port}/fast"
    logs = Path(args.log_dir)
    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    mock: Optional[subprocess.Popen] = None
    engine: Optional[subprocess.Popen] = None
    try:
        mock = spawn(
            [args.mock, "-port", str(args.mock_port), "-host", "127.0.0.1"],
            logs / "mock-server.log",
        )
        engine = spawn(
            # --verbose 1 is what app/electron/sidecar.ts spawns in production;
            # measuring a quieter engine would measure something nobody runs.
            [args.engine, "--port", str(args.port), "--data-dir", str(data_dir), "--verbose", "1"],
            logs / "engine.log",
        )

        health = wait_for_health(base_url, HEALTH_TIMEOUT_S)
        recorder = Recorder(sampler=resolve_sampler(), pid=engine.pid)

        sample_for(recorder, "idle", args.idle_seconds, IDLE_INTERVAL_S)
        pre_run_rss = recorder.phase_samples("idle")[-1].rss_bytes

        run_id = start_run(base_url, target_url, args.vus, args.load_seconds)
        sample_for(
            recorder,
            "load",
            args.load_seconds + RUN_GRACE_S,
            LOAD_INTERVAL_S,
            until=lambda: run_status(base_url, run_id) in TERMINAL_RUN_STATUSES,
        )

        status = run_status(base_url, run_id)
        if status != "completed":
            raise MeasurementError(f"run {run_id} ended as {status!r}, not completed")

        report = http_json(f"{base_url}/runs/{run_id}/report", timeout=60.0)
        sample_for(recorder, "retention", args.retention_seconds, RETENTION_INTERVAL_S)

        summary = report.get("summary", {})
        retention = recorder.phase_samples("retention")
        return {
            "schema": 1,
            "os": platform.system(),
            "osRelease": platform.release(),
            "machine": platform.machine(),
            "engineVersion": health.get("version"),
            "engineWorkers": health.get("workers"),
            "idle": summarize(recorder.phase_samples("idle")).to_json(),
            "load": {
                "vus": args.vus,
                "durationSeconds": args.load_seconds,
                **summarize(recorder.phase_samples("load")).to_json(),
                "avgRps": summary.get("avgRps"),
                "totalRequests": summary.get("totalRequests"),
                "errorRate": summary.get("errorRate"),
            },
            "retention": {
                **summarize(retention).to_json(),
                "preRunRssBytes": pre_run_rss,
                # The number #1154 is about: what a finished run still holds
                # once the app has stopped looking at it.
                "residualBytes": retention[-1].rss_bytes - pre_run_rss,
            },
            "dataDirBytes": directory_bytes(data_dir),
            "samples": [s.to_json() for s in recorder.samples],
        }
    finally:
        terminate(engine, "engine")
        terminate(mock, "mock-server")


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--engine", required=True, help="path to the vayu-engine binary")
    parser.add_argument("--mock", required=True, help="path to the built mock server")
    parser.add_argument("--out", required=True, help="where to write the JSON result")
    parser.add_argument("--data-dir", default="perf-data", help="scratch engine data dir")
    parser.add_argument("--log-dir", default="perf-logs", help="where child stdout goes")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--mock-port", type=int, default=8080)
    parser.add_argument("--vus", type=int, default=8, help="constant_concurrency VUs")
    parser.add_argument("--idle-seconds", type=float, default=60.0)
    parser.add_argument("--load-seconds", type=int, default=30)
    parser.add_argument("--retention-seconds", type=float, default=60.0)
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    for label, value in (("engine", args.engine), ("mock", args.mock)):
        if not Path(value).exists():
            print(f"[perf] {label} binary not found: {value}", file=sys.stderr)
            return 2

    try:
        result = measure(args)
    except MeasurementError as exc:
        print(f"[perf] measurement failed: {exc}", file=sys.stderr)
        return 1

    Path(args.out).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"[perf] wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

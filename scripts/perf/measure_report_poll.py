#!/usr/bin/env python3
"""Time `GET /runs/:id/report` while a load run is live and while it finalizes.

Written for issue #2659 (the report-poll bound of #2548): a client re-reads a
running load run's report on a timer, and the poll that matters is the one that
lands after the load stopped and before the status turns terminal, while the
run flushes its stored results. The bound is 10 ms of engine time per poll in a
Release build.

Method, per run (three by default):

- start the engine on a free port with a fresh data directory;
- `POST /runs` a `constant_rps` GET at 500 rps for 30 s against a closed
  loopback port, so every request is a transport error and the run stores the
  default error cap (`maxStoredErrors`, 10,000 rows) at the end;
- `GET /runs/:id/report` every 100 ms until the report's `metadata.status` is
  terminal, recording the status each poll answered;
- stop the engine and read its own timing of each poll from the `cat: "http"`
  record in `<data-dir>/logs/engine_*.log` (`ms`, pre-routing to response
  written; see `http/request_log.hpp`), paired with the polls in order. Client
  wall time is recorded beside it and includes the loopback connect.

A poll answered `running` before the load's duration had elapsed is the live
phase; one answered `running` after it is the finalization window. The polls
whose engine interval overlaps the results write (the `Wrote results batch`
record, `rows` and `ms`) are counted separately, so a run whose polls all
missed the flush is visible rather than read as a pass.

Stdlib only, like the other scripts here.

Usage:
    python scripts/perf/measure_report_poll.py \\
        --engine engine/build-release/vayu-engine [--runs 3] [--out poll.json]
"""

from __future__ import annotations

import argparse
import json
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

HEALTH_TIMEOUT_S = 90.0
# Grace beyond the load's duration before a run is called stuck.
RUN_GRACE_S = 90.0
TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "stopped"})
# Port 1 on loopback has no listener, so each request fails at connect.
CLOSED_TARGET_URL = "http://127.0.0.1:1/"


class MeasurementError(RuntimeError):
    """A failure that makes the measurement meaningless rather than merely odd."""


@dataclass
class Poll:
    sent_at: float  # wall clock, seconds
    client_ms: float
    status: str
    engine_ms: float = 0.0
    engine_done_at: float = 0.0  # wall clock of the engine's log record


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def http_json(url: str, body: Optional[dict] = None, timeout: float = 15.0) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        return json.loads(response.read().decode("utf-8"))


def wait_for_health(base_url: str) -> None:
    started = time.monotonic()
    last_error = "no attempt made"
    while time.monotonic() - started < HEALTH_TIMEOUT_S:
        try:
            http_json(f"{base_url}/health", timeout=5.0)
            return
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            last_error = str(exc)
            time.sleep(0.25)
    raise MeasurementError(f"engine did not answer /health: {last_error}")


def poll_until_terminal(base_url: str, run_id: str, deadline_s: float, interval_s: float) -> list[Poll]:
    polls: list[Poll] = []
    url = f"{base_url}/runs/{run_id}/report"
    started = time.monotonic()
    while time.monotonic() - started < deadline_s:
        sent_at = time.time()
        tick = time.perf_counter()
        report = http_json(url, timeout=60.0)
        client_ms = (time.perf_counter() - tick) * 1000.0
        status = str(report.get("metadata", {}).get("status", "unknown"))
        polls.append(Poll(sent_at=sent_at, client_ms=client_ms, status=status))
        if status in TERMINAL_RUN_STATUSES:
            return polls
        # Start-to-start cadence: a slow poll does not stretch the interval.
        time.sleep(max(0.0, interval_s - (time.time() - sent_at)))
    raise MeasurementError(f"run {run_id} was not terminal within {deadline_s:.0f}s")


def parse_ts(value: str) -> float:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp()


def read_engine_log(data_dir: Path, run_id: str) -> tuple[list[dict], Optional[dict]]:
    """The engine's records of each report poll, in order, and the results write."""
    report_path = f"/runs/{run_id}/report"
    polls: list[dict] = []
    flush: Optional[dict] = None
    for log in sorted((data_dir / "logs").glob("engine_*.log")):
        for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("cat") == "http" and record.get("path") == report_path:
                polls.append(record)
            elif record.get("msg") == "Wrote results batch":
                flush = record
    return polls, flush


def terminate(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=15)


def describe(values: list[float]) -> dict:
    if not values:
        return {"count": 0, "p50": None, "max": None}
    return {"count": len(values), "p50": round(statistics.median(values), 2), "max": round(max(values), 2)}


def measure_once(engine_path: str, rps: int, duration_s: int, interval_s: float) -> dict:
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    data_dir = Path(tempfile.mkdtemp(prefix="vayu-report-poll-"))
    engine = subprocess.Popen(
        [engine_path, "--port", str(port), "--data-dir", str(data_dir), "--verbose", "1"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_health(base_url)
        started = http_json(
            f"{base_url}/runs",
            body={
                "method": "GET",
                "url": CLOSED_TARGET_URL,
                "mode": "constant_rps",
                "targetRps": rps,
                "duration": f"{duration_s}s",
            },
        )
        posted_at = time.time()
        run_id = started.get("runId")
        if not run_id:
            raise MeasurementError(f"POST /runs returned no runId: {started}")
        polls = poll_until_terminal(base_url, run_id, duration_s + RUN_GRACE_S, interval_s)
        final = http_json(f"{base_url}/runs/{run_id}/report", timeout=60.0)
    finally:
        terminate(engine)

    try:
        records, flush = read_engine_log(data_dir, run_id)
    finally:
        shutil.rmtree(data_dir, ignore_errors=True)
    # The final read above is one record past the polls.
    if len(records) != len(polls) + 1:
        raise MeasurementError(f"{len(polls)} polls but {len(records)} engine records of them")
    for poll, record in zip(polls, records):
        poll.engine_ms = float(record["ms"])
        poll.engine_done_at = parse_ts(record["ts"])

    load_stops_at = posted_at + duration_s
    running = [p for p in polls if p.status == "running"]
    live = [p for p in running if p.sent_at < load_stops_at]
    finalizing = [p for p in running if p.sent_at >= load_stops_at]
    during_flush: list[Poll] = []
    if flush is not None:
        flush_end = parse_ts(flush["ts"])
        flush_start = flush_end - float(flush["ms"]) / 1000.0
        during_flush = [
            p for p in running if p.engine_done_at >= flush_start and p.engine_done_at - p.engine_ms / 1000.0 <= flush_end
        ]
    return {
        "runId": run_id,
        "resultsStored": final.get("resultsStored"),
        "flushRows": flush.get("rows") if flush else None,
        "flushMs": round(float(flush["ms"]), 1) if flush else None,
        "liveEngineMs": describe([p.engine_ms for p in live]),
        "liveClientMs": describe([p.client_ms for p in live]),
        "finalizingEngineMs": describe([p.engine_ms for p in finalizing]),
        "finalizingClientMs": describe([p.client_ms for p in finalizing]),
        "duringFlushEngineMs": describe([p.engine_ms for p in during_flush]),
        # Each poll of the window, for a maximum that needs explaining.
        "finalizingPolls": [
            {"engineMs": round(p.engine_ms, 2), "clientMs": round(p.client_ms, 2), "duringFlush": p in during_flush}
            for p in finalizing
        ],
    }


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--engine", required=True, help="path to a Release vayu-engine binary")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--rps", type=int, default=500)
    parser.add_argument("--duration", type=int, default=30, help="load duration, seconds")
    parser.add_argument("--interval-ms", type=float, default=100.0, help="poll cadence")
    parser.add_argument("--out", help="also write the results here as JSON")
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    if not Path(args.engine).is_file():
        print(f"[perf] no engine binary at {args.engine}", file=sys.stderr)
        return 2
    results = []
    for index in range(args.runs):
        result = measure_once(args.engine, args.rps, args.duration, args.interval_ms / 1000.0)
        results.append(result)
        print(
            f"[perf] run {index + 1}: rows {result['resultsStored']} "
            f"(flush {result['flushMs']} ms) | live engine ms {result['liveEngineMs']} | "
            f"finalizing engine ms {result['finalizingEngineMs']} | "
            f"during flush {result['duringFlushEngineMs']}"
        )
    worst = [r["finalizingEngineMs"]["max"] for r in results if r["finalizingEngineMs"]["max"] is not None]
    print(f"[perf] max finalizing poll per run (engine ms): {worst}")
    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

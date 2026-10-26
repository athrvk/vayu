#!/usr/bin/env python3
"""A/B the redirect-hop progress hook on one engine daemon (issue #2940).

`setup_easy_handle` installs libcurl's xferinfo callback and sets NOPROGRESS=0
whenever a request follows redirects, which is the default. The arm is the
run's own `followRedirects`: `false` skips the branch (hook off), `true` takes
it (hook on). Same daemon, same target, same run config, so no restart
separates the arms and the only other difference is CURLOPT_FOLLOWLOCATION.

Pairs are interleaved ABBA-style (the first arm alternates per pair) so drift
lands on both arms. `--null` runs the hook-on arm on both sides: the spread
that reports is the harness's noise floor, the number the on/off difference
has to beat.

Stdlib only; the sampler is measure_engine.py's.

    python scripts/perf/ab_redirect_hook.py --engine engine/build/vayu-engine \
        --mock ./mock-server --case rps20000 --pairs 12
"""

from __future__ import annotations

import argparse
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import measure_engine as me  # noqa: E402

BLOB_BYTES = 1 << 20

# case -> (path on the mock, run-body fields). `rps20000` is open-loop; the other
# two are the closed-loop saturation cases bench-compare.sh's vayu_rate runs.
CASES = {
    "rps20000": ("/fast", {"mode": "constant_rps", "rps": 20000}),
    "cc64": ("/fast", {"mode": "constant_concurrency", "concurrency": 64}),
    "blob1mib": (f"/blob/{BLOB_BYTES}", {"mode": "constant_concurrency", "concurrency": 64}),
}


def one_run(base_url: str, recorder: me.Recorder, case: str, follow: bool, args) -> dict:
    path, fields = CASES[case]
    body = {
        "method": "GET",
        "url": f"http://127.0.0.1:{args.mock_port}{path}",
        "headers": {},
        "duration": f"{args.seconds}s",
        "followRedirects": follow,
        **fields,
    }
    before = recorder.take("ab").cpu_seconds
    run_id = me.http_json(f"{base_url}/runs", body=body).get("runId")
    if not run_id:
        raise me.MeasurementError("POST /runs returned no runId")
    deadline = time.monotonic() + args.seconds + me.RUN_GRACE_S
    while me.run_status(base_url, run_id) not in me.TERMINAL_RUN_STATUSES:
        if time.monotonic() > deadline:
            raise me.MeasurementError(f"run {run_id} did not finish")
        time.sleep(0.5)
    after = recorder.take("ab").cpu_seconds
    report = me.http_json(f"{base_url}/runs/{run_id}/report", timeout=60.0)
    summary = report["summary"]
    total = summary["totalRequests"]
    seconds = summary.get("testDuration") or args.seconds
    out = {
        "rps": total / seconds,
        "cpu_per_1k": (after - before) / total * 1000.0 if total else float("nan"),
        "bytes": summary.get("bytesReceived", 0),
        "skipped": summary.get("skippedRequests", 0),
        "achievement": (report.get("rateControl") or {}).get("achievement"),
        "errors": summary.get("errorRate"),
    }
    out["mb_per_s"] = out["bytes"] / seconds / 1e6
    out["cpu_ms_per_mb"] = (after - before) * 1000.0 / (out["bytes"] / 1e6) if out["bytes"] else float("nan")
    return out


def pct(a: float, b: float) -> float:
    return (a - b) / b * 100.0


def med(rows: list[dict], key: str) -> float:
    return statistics.median(r[key] for r in rows)


def report(case: str, label_a: str, label_b: str, a: list[dict], b: list[dict], rate: bool) -> None:
    print(f"\n### {case}: {label_a} vs {label_b} ({len(a)} pairs)\n")
    print(f"| statistic | {label_a} | {label_b} | delta |")
    print("|---|---:|---:|---:|")
    keys = [("median req/s", "rps"), ("median CPU s per 1,000 requests", "cpu_per_1k")]
    if case == "blob1mib":
        keys += [("median MB/s", "mb_per_s"), ("median CPU ms per MB", "cpu_ms_per_mb")]
    for name, key in keys:
        ma, mb = med(a, key), med(b, key)
        print(f"| {name} | {ma:,.3f} | {mb:,.3f} | {pct(ma, mb):+.2f}% |")
    mean_a = statistics.mean(r["rps"] for r in a)
    mean_b = statistics.mean(r["rps"] for r in b)
    print(f"| mean req/s | {mean_a:,.0f} | {mean_b:,.0f} | {pct(mean_a, mean_b):+.2f}% |")
    for label, rows in ((label_a, a), (label_b, b)):
        spread = (max(r["rps"] for r in rows) - min(r["rps"] for r in rows)) / med(rows, "rps") * 100
        print(f"\n{label}: req/s min {min(r['rps'] for r in rows):,.0f} max {max(r['rps'] for r in rows):,.0f}"
              f" (spread {spread:.1f}% of median)", end="")
        if rate:
            ach = [r["achievement"] for r in rows if r["achievement"] is not None]
            print(f"; achievement median {statistics.median(ach):.3f}" if ach else "", end="")
            print(f"; skipped requests median {med(rows, 'skipped'):,.0f}", end="")
        print()
    paired = [pct(x["rps"], y["rps"]) for x, y in zip(a, b)]
    print(f"\nper-pair req/s delta: median {statistics.median(paired):+.2f}%,"
          f" min {min(paired):+.2f}%, max {max(paired):+.2f}%")


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--engine", required=True)
    p.add_argument("--mock", required=True)
    p.add_argument("--case", choices=sorted(CASES), required=True)
    p.add_argument("--pairs", type=int, default=12)
    p.add_argument("--seconds", type=int, default=30)
    p.add_argument("--cooldown", type=float, default=4.0)
    p.add_argument("--null", action="store_true", help="hook-on on both sides: the noise floor")
    p.add_argument("--data-dir", default="perf-data")
    p.add_argument("--log-dir", default="perf-logs")
    p.add_argument("--port", type=int, default=9876)
    p.add_argument("--mock-port", type=int, default=8080)
    args = p.parse_args(argv)

    base_url = f"http://127.0.0.1:{args.port}"
    Path(args.data_dir).mkdir(parents=True, exist_ok=True)
    mock = engine = None
    try:
        mock = me.spawn([args.mock, "-port", str(args.mock_port), "-host", "127.0.0.1"],
                        Path(args.log_dir) / "mock-server.log")
        engine = me.spawn([args.engine, "--port", str(args.port), "--data-dir", args.data_dir,
                           "--verbose", "1"], Path(args.log_dir) / "engine.log")
        me.wait_for_health(base_url, me.HEALTH_TIMEOUT_S)
        recorder = me.Recorder(sampler=me.resolve_sampler(), pid=engine.pid)

        # Arm "first" is hook-off, "second" hook-on; --null makes both hook-on.
        arms = {"off": args.null, "on": True}
        one_run(base_url, recorder, args.case, True, args)  # warm-up, discarded
        rows = {"off": [], "on": []}
        for i in range(args.pairs):
            order = ["off", "on"] if i % 2 == 0 else ["on", "off"]
            for arm in order:
                rows[arm].append(one_run(base_url, recorder, args.case, arms[arm], args))
                time.sleep(args.cooldown)
        a_label, b_label = ("on (A)", "on (B)") if args.null else ("hook on", "hook off")
        a, b = (rows["off"], rows["on"]) if args.null else (rows["on"], rows["off"])
        report(args.case, a_label, b_label, a, b, args.case == "rps20000")
    finally:
        me.terminate(engine, "engine")
        me.terminate(mock, "mock-server")
    return 0


if __name__ == "__main__":
    sys.exit(main())

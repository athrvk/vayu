#!/usr/bin/env python3
"""Render the perf-measure JSON artifacts as one Markdown table per OS.

Reads what `measure_engine.py` and `measure-app.mjs` wrote and prints a table to
stdout - the workflow appends it to `$GITHUB_STEP_SUMMARY`, so the run page
carries the numbers without anyone downloading the artifact. The artifact stays
the record; this is the reading of it.

Missing input is reported as a row saying so rather than skipped: a leg that did
not run is the single most important thing a reader needs to see, and a summary
that silently omits it looks like a measurement nobody took.

Usage:
    python scripts/perf/summarize.py --os ubuntu-latest \
        --engine-json perf-engine.json --app-json perf-app.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

MIB = 1024 * 1024


def load(path: Optional[str]) -> Optional[dict]:
    if not path:
        return None
    file = Path(path)
    if not file.exists():
        return None
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"[perf] {file} is not valid JSON: {exc}", file=sys.stderr)
        return None


def mib(value: Optional[float]) -> str:
    return "-" if value is None else f"{value / MIB:.1f} MB"


def num(value: Optional[float], suffix: str = "", digits: int = 1) -> str:
    return "-" if value is None else f"{value:,.{digits}f}{suffix}"


def engine_rows(data: Optional[dict]) -> list[tuple[str, str]]:
    if data is None:
        return [("engine leg", "**did not produce a result**")]

    idle, load, retention = data["idle"], data["load"], data["retention"]
    return [
        ("engine version", str(data.get("engineVersion", "-"))),
        ("engine workers", str(data.get("engineWorkers", "-"))),
        ("idle RSS (last / max)", f"{mib(idle['rssLastBytes'])} / {mib(idle['rssMaxBytes'])}"),
        ("idle CPU", num(idle["cpuPercentOfOneCore"], "% of one core", 2)),
        ("idle threads", str(idle["threadsLast"])),
        (
            f"load: {load['vus']} VU / {load['durationSeconds']}s avg RPS",
            num(load.get("avgRps"), "", 0),
        ),
        ("load requests / error rate", f"{num(load.get('totalRequests'), '', 0)} / {num(load.get('errorRate'), '', 4)}"),
        ("load RSS peak", mib(load["rssMaxBytes"])),
        ("load CPU", num(load["cpuPercentOfOneCore"], "% of one core", 1)),
        ("load threads (max)", str(load["threadsMax"])),
        ("post-run RSS after 60s", mib(retention["rssLastBytes"])),
        ("post-run residual vs pre-run", mib(retention["residualBytes"])),
        ("data dir after the run", mib(data.get("dataDirBytes"))),
    ]


def app_rows(data: Optional[dict]) -> list[tuple[str, str]]:
    if data is None:
        return [("app leg", "**did not produce a result**")]

    bundle = data.get("bundle") or {}
    startup = data.get("startup") or {}
    rows = [
        ("renderer entry chunk", f"`{bundle.get('entryChunkName', '-')}` {mib(bundle.get('entryChunkBytes'))}"),
        ("renderer dist total", mib(bundle.get("totalDistBytes"))),
        ("renderer dist files", str(bundle.get("fileCount", "-"))),
        ("startup method", str(startup.get("method", "-"))),
        ("ready-to-show (median)", num(startup.get("medianMs"), " ms", 0)),
    ]
    if startup.get("note"):
        rows.append(("startup note", str(startup["note"])))

    spawn = data.get("tasklistSpawn")
    if spawn:
        rows.append(
            (
                f"Windows tasklist spawn (median of {spawn.get('iterations', '?')})",
                num(spawn.get("medianMs"), " ms", 1),
            )
        )
    return rows


def render(os_label: str, engine: Optional[dict], app: Optional[dict]) -> str:
    lines = [f"### Perf measurement - `{os_label}`", "", "| metric | value |", "| --- | --- |"]
    for label, value in engine_rows(engine) + app_rows(app):
        lines.append(f"| {label} | {value} |")
    lines.append("")
    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--os", required=True, help="runner label, used as the heading")
    parser.add_argument("--engine-json")
    parser.add_argument("--app-json")
    args = parser.parse_args(argv)

    print(render(args.os, load(args.engine_json), load(args.app_json)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

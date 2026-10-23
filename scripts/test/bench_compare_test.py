#!/usr/bin/env python3
"""
scripts/test/bench-compare.sh stays runnable against the engine (#2407).

The script submits a Vayu run whose "mode" the engine must parse, and holds
vegeta at the headline settings docs/engine/benchmarks.md reports. Nothing else
runs the script (it needs wrk, vegeta, a mock server and a daemon), so a mode
name the engine stopped parsing would go unnoticed until someone benchmarked.
The accepted names are read out of `parse_load_test_type` in
engine/include/vayu/types.hpp, not restated.

Run: python3 scripts/test/bench_compare_test.py
"""

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "test" / "bench-compare.sh"
TYPES_HEADER = REPO_ROOT / "engine" / "include" / "vayu" / "types.hpp"

EXPECTED_MODES = {"constant_rps", "constant_concurrency", "iterations", "ramp_up", "capacity"}

PASSED = 0
FAILED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        print(f"  ok - {name}")
        PASSED += 1
    else:
        print(f"  FAIL - {name}")
        print(f"         {detail}")
        FAILED += 1


def engine_modes(header_text: str) -> set:
    """The names parse_load_test_type compares its argument against."""
    body = re.search(
        r"parse_load_test_type\s*\([^)]*\)\s*\{(.*?)\n\}", header_text, re.DOTALL
    )
    if body is None:
        return set()
    return set(re.findall(r'str\s*==\s*"([^"]+)"', body.group(1)))


def main() -> int:
    script = SCRIPT.read_text()
    header = TYPES_HEADER.read_text()
    print("bench-compare.sh against the engine's names")
    print()

    check("the script was read", bool(script.strip()), f"{SCRIPT} is empty")
    accepted = engine_modes(header)
    check("parse_load_test_type names were parsed out of types.hpp",
          bool(accepted), "no `str == \"...\"` comparisons found")
    check("the parsed names include all five load test types",
          EXPECTED_MODES <= accepted, f"parsed {sorted(accepted)}")

    submitted = re.findall(r'"mode"\s*:\s*"([^"]*)"', script)
    check("the script submits at least one mode", bool(submitted),
          "no \"mode\":\"...\" found")
    for mode in submitted:
        check(f'submitted mode "{mode}" is one the engine parses', mode in accepted,
              f"engine accepts {sorted(accepted)}")

    check("vegeta runs at the headline rate", "-rate=90000" in script,
          "expected -rate=90000 in the vegeta attack")
    check("vegeta runs at the headline worker cap", "-max-workers=400" in script,
          "expected -max-workers=400 in the vegeta attack")

    print()
    print(f"  {PASSED} passed, {FAILED} failed")
    if PASSED == 0:
        print("  no assertions ran - the suite proved nothing")
        return 1
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())

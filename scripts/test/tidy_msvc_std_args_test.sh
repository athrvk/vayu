#!/usr/bin/env bash
# What scripts/tidy-msvc-std-args.sh answers for each spelling a compile
# database can carry. Mutation check: make the c++[0-9][0-9] case print
# nothing and the `-std:c++23` case fails; widen the pattern to `std=` and the
# GCC case fails.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/tidy-msvc-std-args.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0

expect() { # name, database text, expected stdout, expected exit
  local name="$1" text="$2" want="$3" want_rc="$4" got rc
  printf '%s' "$text" > "$tmp/db.json"
  got="$(bash "$script" "$tmp/db.json" 2>/dev/null)"; rc=$?
  if [[ "$got" != "$want" || "$rc" != "$want_rc" ]]; then
    echo "FAIL $name: got '$got' rc=$rc, want '$want' rc=$want_rc"; fail=1
  else
    echo "ok   $name"
  fi
}

expect "msvc c++23 gets the override" '"command": "cl.exe /nologo -std:c++23 /c a.cpp"' '--extra-arg=/clang:-std=c++23' 0
expect "msvc c++latest is read natively" '"command": "cl.exe /std:c++latest /c a.cpp"' '' 0
expect "msvc c++23preview is read natively" '"command": "cl.exe -std:c++23preview /c a.cpp"' '' 0
expect "gcc spelling prints nothing" '"command": "g++ -std=gnu++23 -c a.cpp"' '' 0
expect "c target is not a c++ standard" '"command": "cl.exe /std:c17 /c a.c"' '' 0
expect "mixed standards are refused" '"command": "cl.exe -std:c++23 a.cpp", "x": "cl.exe /std:c++20 b.cpp"' '' 1
expect "unknown spelling is refused" '"command": "cl.exe /std:c++2c /c a.cpp"' '' 1
exit "$fail"

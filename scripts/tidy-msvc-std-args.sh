#!/usr/bin/env bash
# The clang-tidy argument that restores the C++ standard an MSVC compile
# database names in a spelling clang-cl cannot read. Prints the argument on
# stdout (nothing when none is needed) and says what it found on stderr.
#
# CMake 4.5 writes `-std:c++23` for MSVC 19.52.37029 and later, where it wrote
# `-std:c++latest` before. clang-cl 22 maps `c++latest`, `c++23preview`, `c++20`
# and `c++17`, and ignores `c++23` as an unused argument, so clang-tidy parses
# every translation unit as C++14. `-Wno-unused-command-line-argument` (the
# gates pass it for `/Zc:preprocessor`) hides the one diagnostic that says so.
#
# The value is read from the database, so `CMAKE_CXX_STANDARD` stays the one
# place the standard is named. The match is the MSVC colon spelling, never the
# runner: a GCC or Clang database writes `-std=c++23` or `-std=gnu++23`, which
# does not match, so Linux and macOS print nothing.
#
# Exit: delete this script once the clang-tidy floor is an LLVM whose clang-cl
# maps `/std:c++23` (main has it; 22.x and 23.x do not).
#
# Usage: arg="$(bash scripts/tidy-msvc-std-args.sh engine/build-release/compile_commands.json)"
#        "$tidy" ... ${arg:+"$arg"}
set -euo pipefail

db="${1:?usage: tidy-msvc-std-args.sh <compile_commands.json>}"

found="$(grep -oE '[-/]std:c\+\+[0-9A-Za-z]+' "$db" | sed 's/^.//' | sort -u || true)"
echo "compile database MSVC C++ standard: ${found:-none (GCC/Clang spelling)}" >&2

case "$found" in
  '' | std:c++14 | std:c++17 | std:c++20 | std:c++23preview | std:c++latest) ;;
  std:c++[0-9][0-9]) printf '%s\n' "--extra-arg=/clang:-std=${found#std:}" ;;
  *)
    echo "::error::unrecognised or mixed MSVC /std: in the compile database: $(echo "$found" | tr '\n' ' ')" >&2
    exit 1
    ;;
esac

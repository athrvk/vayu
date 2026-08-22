# C++ feature probe

Measures which C++ features a toolchain actually offers, per platform, at a
standard the engine has not adopted yet. It exists because the engine ships on
three vendors whose library support lands years apart, and a standard bump is a
decision about the worst of them - a question that is answerable by measurement
and unanswerable from memory.

Nothing here is compiled into a Vayu artifact, and the engine's own standard
(`engine/CMakeLists.txt`) is neither read nor written by this project.

## Running it

Everything happens at CMake configure time; there is no build step.

```bash
# the default compiler
cmake -S scripts/cxx-feature-probe -B /tmp/probe

# a specific one - which is how the "should the runner pin gcc-14" kind of
# question gets an answer
cmake -S scripts/cxx-feature-probe -B /tmp/probe -DCMAKE_CXX_COMPILER=g++-14

# a later standard, once C++23 is the baseline
cmake -S scripts/cxx-feature-probe -B /tmp/probe -DVAYU_PROBE_STANDARD=26
```

The table lands in the configure log and in `<build dir>/probe-results.md`.

In CI it is `.github/workflows/cxx-feature-probe.yml`: four legs (Ubuntu on its
default `g++` and on `g++-14`, macOS on AppleClang, Windows on MSVC), run on
demand through **Run workflow** and automatically on a pull request that
changes the probe or its workflow. Each leg writes its table into the job
summary.

## What a result means

A feature is reported available only if its translation unit **compiles and
links**. That is deliberate and it is not the same as "the header exists":
`<stacktrace>` is present on libstdc++ 13 and unusable without `-lstdc++exp`,
which the probe does not pass. The usable definition is the one a migration
needs.

A "no" is an answer, not a failure - the job stays green while reporting one.
The probe fails only when it cannot measure: an unknown standard
(`VAYU_PROBE_STANDARD` older than the engine's C++20 baseline), or the dialect
self-check in `probes/dialect_selected.cpp` failing, which means the standard
never reached the compiler and every verdict below it would be a measurement of
the wrong dialect.

## Adding a probe

One self-contained `probes/<feature>.cpp` with a `main`, plus one `vayu_probe()`
line in `CMakeLists.txt` naming it and saying why the answer matters. Write the
source so it cannot compile without the feature - a probe that passes on a
toolchain lacking the feature is worse than no probe.

The recorded results, and the floor decision taken from them, live on the issue
that asked for the measurement (#901 for C++23) rather than in this directory,
so that no file here can quietly drift out of date against the runner images.

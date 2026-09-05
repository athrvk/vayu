---
description: >-
  Build the Vayu C++ engine from source - CMake presets, vcpkg dependencies, test targets, and per-platform notes.
---

# Building Vayu Engine

## Quick Build

From the project root:

```bash
# Release build + tests
python build.py -e -t

# Debug build + tests
python build.py --dev -e -t

# Build without tests
python build.py -e

# Clean build
python build.py -c -e

# Run tests only (no rebuild)
python build.py --test-only
```

## Prerequisites

- **CMake**: 3.25 or higher
- **C++ Compiler**: C++23 capable, which since #901 means the library, not just
  the dialect flag
  - GCC 13+ (13.3 is what CI builds on)
  - Clang 19+ against libstdc++ - clang 18 compiles C++23 but cannot see
    libstdc++'s `<expected>`, which is gated behind a concepts macro it does not
    advertise; against libc++ it is fine from 18
  - AppleClang as shipped with a current Xcode (CI measures 21)
  - MSVC 2022+ (Windows; CI measures 19.51)

  These are measurements, not folklore - see the feature probe below.
- **vcpkg**: Package manager (auto-detected or install separately)
- **Ninja**: Build system (optional, but recommended for faster builds)
- **Autotools** (Linux and macOS only): `autoconf`, `autoconf-archive`,
  `automake` and `libtool`. vcpkg builds **libsodium** from source through its
  autotools path and runs `autoreconf` first, so a box without these fails at
  dependency install with *"libsodium currently requires the following programs
  from the system package manager"*, before any Vayu source is compiled.
  `python build.py --setup` installs them. Windows needs nothing extra -
  the port builds libsodium with MSBuild there.

  ```bash
  sudo apt install autoconf autoconf-archive automake libtool   # Debian/Ubuntu
  brew install autoconf autoconf-archive automake libtool       # macOS
  ```

## Manual Build

### Using CMake Presets (Recommended)

```bash
cd engine

# Release build
cmake --preset linux-prod    # or macos-prod, windows-prod
cmake --build --preset linux-prod

# Debug build
cmake --preset linux-dev     # or macos-dev, windows-dev
cmake --build --preset linux-dev

# Debug build with AddressSanitizer, into its own build-asan/ tree
cmake --preset linux-asan
cmake --build --preset linux-asan
ctest --preset linux-asan
```

There are four more sanitizer presets - `linux-tsan`, `macos-asan`,
`macos-tsan`, `windows-asan` - see [Sanitizers](#sanitizers) below.

### Traditional CMake

```bash
cd engine

# Release build with Ninja (recommended)
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release

# Debug build
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug

# Build
cmake --build build
```

### Build Options

CMake options can be set during configuration:

```bash
# Disable CLI build
cmake -B build -DVAYU_BUILD_CLI=OFF

# Disable engine daemon build
cmake -B build -DVAYU_BUILD_ENGINE=OFF

# Disable tests
cmake -B build -DVAYU_BUILD_TESTS=OFF

# Enable AddressSanitizer (debug builds)
cmake -B build -DCMAKE_BUILD_TYPE=Debug -DVAYU_USE_ASAN=ON

# Enable ThreadSanitizer (debug builds; Linux and macOS only - it stops at
# configure with a FATAL_ERROR on MSVC)
cmake -B build -DCMAKE_BUILD_TYPE=Debug -DVAYU_USE_TSAN=ON

# Treat compiler warnings as errors (what CI does)
cmake -B build -DVAYU_WERROR=ON
```

## Sanitizers

Five preset trios, one per sanitizer-and-platform combination that exists:

| Preset | Platform | Finds |
|--------|----------|-------|
| `linux-asan` | Linux | Memory errors **and leaks** - LeakSanitizer is on by default here |
| `linux-tsan` | Linux | Data races, lock-order inversions |
| `macos-asan` | macOS | Memory errors. **No leak detection in practice** - see below |
| `macos-tsan` | macOS | Data races, lock-order inversions |
| `windows-asan` | Windows | Memory errors, via MSVC `/fsanitize=address`. **No container-overflow detection** - see below |

**The Windows leg detects slightly less than the other two.** MSVC's STL turns
on ASan container annotations for `string`, `vector` and `optional` under
`/fsanitize=address` and stamps every translation unit with a `detect_mismatch`
record; the vcpkg dependencies are prebuilt without ASan and stamp the opposite
value, so the linker refuses the whole binary (`LNK2038 ... annotate_string`,
ending in `LNK1319`). The engine turns those annotations off on its own side,
which is Microsoft's documented answer for linking against uninstrumented
libraries - instrumenting the dependencies would need a custom triplet, and
their archives are shared byte for byte with every other workflow's vcpkg
cache. The cost is bounded: Windows no longer catches an overflow that stays
inside a container's *spare capacity* (past `size()`, within `capacity()`).
Heap, stack and global overflow, use-after-free, double-free and
use-after-return are all untouched, and Linux and macOS keep the annotations -
so the matrix as a whole loses nothing.

There is deliberately no `windows-tsan`. ThreadSanitizer has no Windows
implementation - MSVC ships none, and clang-cl does not implement it either - so
`-DVAYU_USE_TSAN=ON` on MSVC stops at configure with a `FATAL_ERROR` rather than
dropping the flag and handing back an unsanitized binary that looks sanitized.

Each preset name is a trio - configure, build and test - so a run is three
commands with the same word in them:

```bash
cd engine
cmake --preset linux-tsan          # or macos-tsan, macos-asan, windows-asan
cmake --build --preset linux-tsan
ctest --preset linux-tsan
```

Every sanitizer preset builds into **its own tree** (`build-asan/`,
`build-tsan/`) rather than turning a flag on inside `build/`, so a sanitizer run
never invalidates the ordinary build's objects - and ASan and TSan, which cannot
coexist in one binary, never fight over one directory. Their test presets run
`ctest -j2` rather than the usual `-j8`: sanitizer processes are memory-hungry
(TSan's shadow memory alone is gigabytes per process) and oversubscribing turns
findings into noise.

`windows-asan` is the exception, and keeps the platform's usual `-j4`. ASan's
memory overhead is roughly 3x rather than TSan's 10x, and the scratch-database
tests there already share a CTest `RESOURCE_LOCK`, so `-j2` bought nothing.

**Parallelism is not what governs that leg's wall time, and it is worth knowing
why before reaching for `-j`.** On Windows the scratch-database tests are
serialized by that `RESOURCE_LOCK` and are ~81% of the serial wall (see the root
`CLAUDE.md`), so no `-j` setting can shorten them. What actually cost the first
run was neither: see [the ASan runtime DLL](#the-asan-runtime-dll-on-windows).

### The per-test timeout scales with the sanitizer

CTest kills any test that runs longer than a per-test `TIMEOUT`, set in
`engine/tests/CMakeLists.txt`. It is a deadlock net, not a budget - and it scales
with the instrumentation:

| Build | Per-test timeout |
|-------|------------------|
| Ordinary | 60s |
| `VAYU_USE_ASAN` | 300s |
| `VAYU_USE_TSAN` | 600s |

60s is six times the slowest healthy test (~10s) in an ordinary build, which is
thin once AddressSanitizer's ~2x or ThreadSanitizer's 5-15x is applied to it.
The multipliers hold roughly that same ratio.

**This is headroom, not a fix for anything observed**, and the distinction
matters. No leg has ever needed it: a `linux-tsan` run in CI reported 70
failures out of 2367 with **zero** timeouts, finishing its test phase in 275s
with the slowest passing test around 10s. Configure prints the value it chose
(`Per-test CTest timeout: ...s`), so a leg that is slow for some other reason is
not mistaken for this one.

The trade-off has one correction the Windows run below taught: when a hang is
*systemic* rather than confined to one test, a generous net multiplies the cost
by the number of tests and only the job timeout saves you. So these are sized to
cover a slow healthy test and no further.

### The ASan runtime DLL on Windows

A `/MT` or `/MTd` binary still has a **runtime** dependency on
`clang_rt.asan_dynamic-x86_64.dll`. Statically linking the CRT does not
statically link the ASan runtime, and has not since VS 2022 17.7. Microsoft
ships that DLL next to the compiler and documents that the directory is on PATH
*"in debugging sessions and in Visual Studio developer command prompts"* - which
a plain CI shell is not.

Without it every test process fails to start, prints nothing, and is killed by
the per-test timeout. `windows-asan` showed exactly that twice before the
developer environment was applied: **2368 tests, every one `***Timeout`**,
including ones that do nothing but create a file. With it, the same suite runs.

**A wall of identical timeouts on that leg means the binary cannot start.** It
reads like a slow sanitizer and is not one - no slowdown factor makes a test
that creates a file take three minutes. Check the runtime before touching `-j`
or the timeout; both have been tried and neither was the cause.

The workflow gets that PATH the supported way - `ilammy/msvc-dev-cmd`, which is
what the ecosystem uses - rather than searching for the DLL by hand. Two
revisions did search by hand and both got it wrong, once by taking whichever
host/target copy the filesystem returned first (an install ships one per pair
and they are not interchangeable).

It also sets `ASAN_WIN_CONTINUE_ON_INTERCEPTION_FAILURE`. That is Microsoft's
documented escape from a *hang*: the runtime hotpatches interceptors into system
functions, and where a prologue is too short to patch, "the program throws a
`debugbreak` and halts" - with no debugger attached, a process that never exits
and never prints, which CTest can only call a timeout. Newer Windows builds are
known to trip this.

Finally, before ctest runs at all, the step loads the test binary once with
`--gtest_list_tests`. That separates "cannot start" from "tests fail" in seconds
and prints the loader's own exit code instead of costing a job timeout and
reporting nothing. It runs on every leg, because a loader problem is not a
Windows-only category.

| Exit code | Meaning |
|-----------|---------|
| `124` | Hung - the `timeout` fired |
| `3221225781` | `STATUS_DLL_NOT_FOUND` |
| `3221225595` | `STATUS_INVALID_IMAGE_FORMAT` - wrong-architecture DLL |
| `3221225794` | `STATUS_DLL_INIT_FAILED` (`0xc0000142`) - see below |

**`STATUS_DLL_INIT_FAILED` has not been seen on this runner.** Once the
developer environment was applied, `windows-asan` started and ran the whole
suite - 2368 tests in 1018s on Windows Server 2025, VS 18, MSVC 19.51.
[actions/runner-images#8891](https://github.com/actions/runner-images/issues/8891)
is an open report of an ASan binary refusing to start on a hosted Windows image
even with the DLL at the documented path, and is worth knowing about, but it is
filed against `windows-2022` / VS 2022 17.7 / MSVC 14.37 - three toolchain
generations behind what this leg uses - so it is a reference, not the verdict on
a fresh `0xc0000142`. Reproduce one against the image actually in use before
concluding the leg is unviable on hosted runners.

### Which one to reach for

**ASan** is the tool for a **lifetime** bug - a crash the ordinary suite only
produces intermittently and without an assertion failure, which is what a
use-after-free across threads looks like. Two things worth knowing:

- Run the suspect tests **under load**, not alone. Issue #646 was a worker
  thread writing through a `Database` its fixture had already destroyed; it
  passed 5/5 in isolation and reproduced on every attempt with four copies of
  the binary running concurrently (each from its own working directory, since
  the fixtures write scratch `test_*.db` files into it).
- `ASAN_OPTIONS=detect_leaks=0` keeps the report to the memory error itself.
  That is a Linux switch in practice. LeakSanitizer is only **on by default**
  on Linux; on macOS it is off by default and can in principle be turned on
  with `detect_leaks=1`, but that needs an open-source clang - Apple's clang
  may not implement it - and it false-positives inside `libobjc` on Apple
  Silicon. CI builds macOS with AppleClang, so treat `macos-asan` as reporting
  memory errors only.

**TSan** is the tool for a result that is wrong rather than absent: a counter
that drifts, a histogram whose buckets do not add up, a flag observed in an
order no thread wrote. Issue #129 was exactly that - a writer-vs-writer
histogram race - and the busy-poll event loop, the SPSC queues and the
relaxed-atomic `MetricsCollector` are the same material. No assertion can
express "these two writes were unordered", which is why the ordinary suite is
green over code TSan has things to say about.

### Suppressions

`engine/sanitizers/asan.supp` and `engine/sanitizers/tsan.supp` are checked in,
and the weekly workflow below points `ASAN_OPTIONS`/`TSAN_OPTIONS` at them. They
exist for frames this repository cannot fix. Two kinds qualify, and the
difference is worth keeping straight:

- **An edge TSan cannot see.** The vcpkg dependencies are built
  uninstrumented, so TSan cannot observe the synchronization inside OpenSSL and
  reports a happens-before edge that is really there. `tsan.supp`'s
  `crypto/hashtable/hashtable.c` entry is this kind.
- **A real race in code that is not ours.** `std::ctype<char>::narrow` fills a
  mutable cache on the process-wide locale without synchronization, and
  cpp-httplib reaches it by constructing a `std::regex` to parse a status line.
  That is a genuine race; it simply has no engine frame anywhere in the stack
  and cannot be fixed from here. Tracked in #967.

**Never suppress engine code.** A finding in `engine/src` or `engine/include` is
the thing the run exists to surface. Every entry must carry the report it
silences, why the frame cannot be fixed here, and the issue tracking its
removal - the same discipline #897 put on `// NOLINT`. `asan.supp` ships empty
but present; `tsan.supp` carries the two entries above, each with its trace.

### The weekly run, and the issues it files

`.github/workflows/sanitizers.yml` runs all five legs against `master` every
Monday at 09:00 UTC, and on demand via **Run workflow**. Both of those only
begin once the file is on the default branch - GitHub registers a `schedule`
and offers `workflow_dispatch` from `master` only - so the first cron fires
after the merge, not on the pull request that adds it. It is weekly rather
than per-pull-request because TSan costs 5-15x in wall time: paying that on
every pull request would push the engine job past an hour for a class of bug
that surfaces on the order of once a release. `VAYU_WERROR` is off there - the
workflow answers "is the engine memory- and thread-correct", not "does it
compile warning-free", which is `pr-tests.yml`'s gate.

A red leg **files a GitHub issue by itself**, from the runner, through
`GITHUB_TOKEN` - no model and no tokens are involved. The issue is titled
`sanitizer: <sanitizer> failure on <runner>` and labelled `sanitizer-failure`,
`component:engine` and `type:bug`, and carries the run link plus the first
sanitizer report block from the log; the full log is attached to the run as an
artifact for 14 days. The title is the dedup key, so a leg that stays red
accumulates comments on one issue instead of filing a new one every Monday.

So: **if you are reading a `sanitizer-failure` issue, that is where it came
from.** Closing it is a human act after the fix - the next failure comments
again, or files fresh if it was closed. Getting it green by adding a
suppression for engine code is not a fix.

**Only the cron and `workflow_dispatch` file.** A `pull_request` run that goes
red fails in the pull request's own checks and files nothing (issue #970) - the
filing step exists because nobody is watching Monday 09:00, and a pull request
has a reviewer watching the surface the failure already appears on. Filing
there wrote a tracker entry saying "`<preset>` went red" about a ref that is
not `master`: #968 was filed from `refs/pull/958/merge` for a test that did not
exist on `master` yet, and had to be verified and closed by hand once the pull
request merged green. The log and the artifact are still uploaded on a pull
request, because those are what the reviewer needs and they file nothing.

### What the matrix found, and where it stands

The first runs turned up four things. Three are fixed; one is suppressed with a
tracking issue.

- **#956** - a real data race: `RunContext`'s event loop was read by the metrics
  thread while the run thread constructed it. 13 of the 14 race reports were
  this one race, on both TSan legs. **Fixed in #965.** A race no assertion could
  express, found on the matrix's first run.
- **#957** - `linux-tsan` segfaulted in all 58 socket-opening tests. vcpkg's
  cpp-httplib port defines `CPPHTTPLIB_USE_NON_BLOCKING_GETADDRINFO`, which on
  glibc selects `getaddrinfo_a()`; glibc services that on a worker thread it
  creates internally, one that never passes ThreadSanitizer's `pthread_create`
  interceptor, so the thread has no TSan state and its first `malloc`
  dereferences a null cache. A crash inside the sanitizer runtime, which is why
  no suppression could reach it. **Fixed** by undefining that macro for the TSan
  build only, so httplib compiles its plain synchronous `getaddrinfo` branch.
- **#959** - `windows-asan` failed one test, and it was not an MSVC quirk.
  `js_class_tag` reads an object's class through a `JS_Call`, which checks
  QuickJS's 256 KB interpreter stack; when 64 nested `js_deep_equal` frames
  exceeded it the call threw, the tag came back empty, both empty tags compared
  equal, and the walk returned a plain "not equal" with the pending
  stack-overflow error discarded. Which guard fired first depended on frame
  size, so the same source answered differently per toolchain. **Fixed** by
  detecting the cycle where it closes instead of capping depth, and by
  propagating the exception. See [Cycle detection, not a depth
  cap](#cycle-detection-not-a-depth-cap) below.
- **#967** - a data race in libstdc++'s locale narrowing cache, reached through
  the `std::regex` cpp-httplib constructs in `parse_status_line`. No engine
  frame anywhere in the stack, so it is **suppressed** in `tsan.supp` with its
  trace and that issue number. It only became visible once #957 was fixed -
  before that the crash masked it. **Still open, and re-measured at `3d2a6a7`
  rather than assumed:** cpp-httplib 0.53.0 made that regex `thread_local`, so
  the window is one construction per thread instead of one per response, but
  deleting the entry and running `ctest --preset linux-tsan` still fails
  `TransportPolicyPaths.LoadRunTraversesManualProxy` on the race - twice out of
  two runs, both sides of the report being pool threads parsing their first
  response - against 2796/2796 with the entry in place. That test alone
  reproduces it 10 times out of 10, which is the cheap way to re-measure this
  one, and the way it was re-measured at `dc25029` after the baseline moved to
  cpp-httplib 0.53.1: 8 of 10 runs raced without the entry, 10 of 10 passed
  with it. Re-measured the same way on the move to cpp-httplib 0.54.1
  (2026-09-05): 10 of 10 raced without the entry, 10 of 10 passed with it, the
  report frame for frame the same - that release rewrote
  `process_and_close_socket` around a `serve_guarded` wrapper and left
  `parse_status_line` alone. What is left is upstream in libstdc++.

The matrix has therefore paid for itself twice over: two engine-side defects
found and fixed, one of them a race the ordinary suite is structurally unable
to see, and one third-party race documented rather than ignored.

### Cycle detection, not a depth cap

Worth stating separately, because the shape of the bug generalises.
`js_deep_equal` used to bound cyclic input with a depth cap alone. A cap bounds
the C recursion only *after* the fact, and N frames is a different amount of
stack on every toolchain - so which guard fires first (ours, or the
interpreter's own stack check) is decided by frame size, and frame size varies
with compiler, optimisation level and sanitizer. That is how #959 passed on GCC
and Clang and failed deterministically on MSVC at `/Od` under ASan.

It now carries the pair of objects at each level of the current path; a pair it
is already comparing *is* a cycle. `a.self = a` reports at depth 1 rather than
65 and never recurses deep enough for frame size to matter. The cap stays as a
backstop for structures that are merely enormous.

`ScriptEngineTest.ExpectEqlOnACycleSurvivesAShallowInterpreterStack` pins it:
shrinking the interpreter stack to 16 KB puts a Linux build on the same side of
that race as MSVC, so the platform-specific failure is now a test that runs
everywhere.

The workflow also runs on a pull request that edits the sanitizer machinery
itself (this workflow, `engine/sanitizers/**`, `engine/CMakeLists.txt`,
`engine/CMakePresets.json`) and on nothing else, so a change to the presets or
the flags is proved by the thing it changes before it reaches the cron.
`engine/CMakeLists.txt` is in that list for the `vayu_sanitizers` target it
defines; the engine's **test source list** moved out to
`engine/tests/CMakeLists.txt` (issue #970) so that adding a test file is no
longer a change to a trigger path - it was running all five legs, ~70 minutes
on the slowest, over machinery the diff could not touch.

## Build Outputs

After building, executables are in `engine/build/`:

```
engine/build/
├── vayu-engine    # HTTP daemon (if VAYU_BUILD_ENGINE=ON)
├── vayu-cli       # CLI tool (if VAYU_BUILD_CLI=ON)
└── vayu_tests     # Test suite (if VAYU_BUILD_TESTS=ON)
```

## Dependencies

Dependencies are managed via vcpkg and specified in `engine/vcpkg.json`:

| Library | Purpose |
|---------|---------|
| curl | HTTP client library - built with `default-features: false` and an explicit `openssl` (plus `http2`, `non-http`), so every platform *verifies* with OpenSSL ([#851](https://github.com/athrvk/vayu/issues/851)). It does not make Windows a single-backend build: the port's `http2` feature itself depends on `curl[ssl]`, which resolves to Schannel there, so the Windows libcurl is MultiSSL and the engine names its backend at startup instead (`pin_tls_backend()`). Keep the explicit `openssl` regardless - without it there is no OpenSSL to name. See [#858](https://github.com/athrvk/vayu/issues/858) |
| libsodium | SHA-256, HMAC-SHA256, base64 and hex (PKCE, Basic/OAuth credentials, `pm.crypto`) |
| nlohmann-json | JSON parsing/serialization |
| valijson | JSON Schema validation of responses against a bound OpenAPI document |
| ryml (rapidyaml) | Reading a stored OpenAPI document, which is YAML as often as JSON (issue #853). Chosen over yaml-cpp and fkYAML by measurement: it is the only one of the three that reproduces js-yaml's reading of the same bytes on the corpus - yaml-cpp discards quoting (the string `"2.0"` comes back as the number 2.0, and `swagger: "2.0"` is what Swagger detection turns on) and fkYAML sorts mapping keys, losing the document order a coverage block prints. It is also 4-27x faster there, at a comparable binary cost. Pulls `c4core` with it. Only `engine/src/core/openapi_document.cpp` includes it |
| cpp-httplib | HTTP server library - built with the `openssl` feature, which the test suite's HTTPS listener needs (custom-CA verification is asserted on a real handshake, not reasoned about) |
| sqlite3 | Embedded database |
| sqlite-orm | C++ ORM for SQLite |
| gtest | Unit testing framework |

### vcpkg Setup

The build script automatically detects and uses vcpkg. If vcpkg is not found:

1. Install vcpkg: https://vcpkg.io/en/getting-started.html
2. Set `VCPKG_ROOT` environment variable:
   ```bash
   export VCPKG_ROOT=/path/to/vcpkg
   ```

The build script will:
- Check for vcpkg installation
- Install missing dependencies automatically
- Use the correct triplet for your platform

## Platform-Specific Notes

All platforms script with the same vendored engine: QuickJS-NG
(`engine/vendor/quickjs-ng`, built via its own CMake as the `qjs` target).

### Linux

- Requires development headers: `libcurl-dev`, `sqlite3-dev`
- Recommended: Use Ninja for faster builds

### macOS

- Requires Xcode Command Line Tools
- The `scripts/pre-commit` hook prepends Homebrew's LLVM directory, so a
  `brew install llvm` clang-tidy and clang-format are found without touching
  `PATH` yourself

### Windows

- Requires Visual Studio 2022 or later
- Uses vcpkg for all dependencies
- CMake generator defaults to Visual Studio solution

#### The Windows build is fully static - keep it that way

The `windows-dev` and `windows-prod` presets build against
**`x64-windows-static`** and set `CMAKE_MSVC_RUNTIME_LIBRARY` to the static
MSVC runtime. `vayu-engine.exe` therefore ships as a single self-contained
binary with **no DLLs beside it** - nothing is copied into
`app/build/resources/bin` except the executable itself.

This is not a size optimisation, it is a correctness requirement. The engine
used to link dynamically, so the shipped binary imported `MSVCP140.dll` and
`VCRUNTIME140.dll` from the Visual C++ redistributable. That redistributable is
**not** part of a clean Windows install, and it was never bundled. On any
machine without it - a fresh VM, a user who has never installed a C++ app -
Windows refused to load the binary, the sidecar died the moment Electron
spawned it, and the app showed only "Disconnected". v0.10.0 and v0.11.0 both
shipped this way. Every developer machine has the redistributable (Visual
Studio installs it), and so does every CI runner, which is why building and
testing the engine never caught it.

Two consequences worth knowing before you change the build:

- **`set(CMAKE_POLICY_DEFAULT_CMP0091 NEW)` in `engine/CMakeLists.txt` is
  load-bearing.** `CMAKE_MSVC_RUNTIME_LIBRARY` is only honoured where policy
  CMP0091 is NEW. Vendored quickjs-ng declares its own
  `cmake_minimum_required(3.10)`, which resets policies inside that
  subdirectory and would leave `qjs` on the dynamic runtime while the rest of
  the tree is static. Mixing two CRTs in one process is not a build error - it
  corrupts the heap at runtime.
- **`.github/check-windows-deps.py` enforces this in CI**, on both PRs and
  releases. It reads the built binary's PE import table and fails if anything
  outside a Windows-OS allowlist appears. Allowlisting the OS rather than
  denylisting the CRT is deliberate: it also catches a new third-party
  dependency nobody has thought of. Run it locally the same way:

  ```powershell
  python -m pip install pefile
  python .github/check-windows-deps.py engine/build-release/vayu-engine.exe
  ```

#### Every Windows executable needs the compatibility manifest

`engine/res/vayu-windows.manifest` is embedded into `vayu-engine`, `vayu-cli`
and `vayu_tests` by `vayu_embed_windows_manifest()` in
`engine/CMakeLists.txt`, and both guards below assert it.

The chain it was added for, written out because no part of it is guessable from
the flag (line numbers are curl 8.21.0, the pinned version):

1. libcurl's Schannel backend reaches HTTP/2 over TLS only through ALPN.
2. It enables ALPN only when the OS is at least Windows 8.1 (`s_win_has_alpn`,
   `lib/vtls/schannel.c:2620`).
3. That check prefers ntdll's `RtlVerifyVersionInfo`, which tells the truth -
   but resolves the pointer to it in `Curl_win32_init()`, which `global_init()`
   runs *after* `Curl_ssl_init()` (`lib/easy.c:143` then `:153`).
   `s_win_has_alpn` is assigned inside `schannel_init()`, i.e. from within
   `Curl_ssl_init()`, so the one call that decides ALPN for the whole process
   falls back to `VerifyVersionInfoW` (`lib/curlx/version_win32.c:207-210`).
4. `VerifyVersionInfoW` is version-shimmed: since Windows 8.1 it reports 6.2 to
   any process whose manifest does not declare support for a later OS. 6.2 <
   6.3, so ALPN is switched off for the life of the process - **HTTP/2 never
   negotiated**, with a `200 OK` and a reported `HTTP/1.1` for a request that
   asked for h2.

The manifest's `supportedOS` ids turn the shim off. v0.11.0 through v0.14.0
shipped without it and HTTP/2 was dead on Windows the whole time
([#215](https://github.com/athrvk/vayu/issues/215)) - the failure is invisible,
which is why it is guarded twice: `HttpVersionSupport.WindowsOsVersionIsNotShimmed`
asserts that the test binary is not being version-lied to (both ids, since
`check-windows-deps.py` requires both), and `check-windows-deps.py` scans the
*shipped* `vayu-engine.exe` for the same ids, since a gtest can only vouch for
the process it runs in.

##### Why it is still here, and when it goes

[#851](https://github.com/athrvk/vayu/issues/851) put every leg on OpenSSL,
whose ALPN is not gated on an OS version at all, which reads like step 2 no
longer running. [#856](https://github.com/athrvk/vayu/issues/856) asked what
still depends on the manifest, and the answer is: **the chain is dormant, not
gone, because Schannel is still compiled into this binary.**

The curl port's `http2` feature depends on `curl[ssl]`, which resolves to
Schannel on Windows, so the shipped libcurl is MultiSSL - getting the build down
to one backend is [#858](https://github.com/athrvk/vayu/issues/858). The process
runs on OpenSSL because `pin_tls_backend()` names it through
`curl_global_sslset` before `curl_global_init`, and on a MultiSSL build
`Curl_ssl_init()` calls `init()` on the selected backend alone
(`lib/vtls/vtls.c:595-601`), so `schannel_init()` never runs and step 2 is never
evaluated. That is a runtime selection whose failure path is deliberately
non-fatal - `pin_tls_backend()` logs and continues - so a process that reaches
`curl_global_init` first lands on libcurl's own choice, which reads
`CURL_SSL_BACKEND` from the environment before falling back.

**So the retirement condition is #858, not a date.** When the Windows build is
genuinely single-backend, `schannel_init()` leaves the binary, the manifest's
last dependent goes with it, and the manifest, the gtest and the
`check-windows-deps.py` manifest check are deleted together.

##### What else reads a shimmed OS version: nothing

The `supportedOS` ids change what `GetVersionEx` / `VerifyVersionInfoW` report
to the **whole process**, so #856 enumerated every other reader in the engine
and its statically-linked dependencies. Callers of ntdll's `RtlGetVersion` /
`RtlVerifyVersionInfo` are immune by construction - the shim does not touch
those - so only the `kernel32` family matters:

| Where | Reads a shimmed version? |
|-------|--------------------------|
| Vayu's own sources (`engine/src`, `engine/include`, `engine/vendor`) | No - none read an OS version at all |
| libcurl `lib/vtls/schannel.c:2620` (`s_win_has_alpn`) | **Yes** - the one dependent, and only when `schannel_init()` runs |
| libcurl's nine other version gates: `lib/cf-socket.c:193` (the `TCP_KEEP*` `setsockopt` gate, which is backend-independent), five more in `schannel.c`, three in `schannel_verify.c` | No - all evaluated at connect, handshake or verify time, after `Curl_win32_init()` resolved the ntdll pointer, so they read the true OS whatever the manifest says |
| OpenSSL 3.6.3 | No - calls neither API |
| SQLite (`sqlite3_win32_is_nt()`) | No - it calls `GetVersionEx[AW]`, but reads only `dwPlatformId` (NT vs Win9x), which the shim does not change; and the call compiles out entirely on this SDK target (`NTDDI_VERSION >= NTDDI_WINBLUE`), leaving `osIsNT()` a constant |
| nghttp2, cpp-httplib, libsodium, zlib, brotli, sqlite-orm, GoogleTest, rapidyaml/c4core, valijson, quickjs-ng, HdrHistogram | No |

The file itself is only the `supportedOS` ids - no `requestedExecutionLevel`
(the engine is an unprivileged sidecar and must stay one), no DPI awareness (it
has no windows), no long-path or code-page declaration - so there is no second
reason hiding in it that would survive the first one going away.

Add a fourth executable that links libcurl and you must call
`vayu_embed_windows_manifest()` for it too. Note that the mechanism is a
`.manifest` **source file**, not linker flags: passing
`/MANIFEST:EMBED /MANIFESTINPUT:` through `target_link_options` collides with
the manifest CMake already generates and fails the link with
`CVT1100: duplicate resource`.

Linux and macOS need none of this - ALPN there is not gated on an OS version
check.

## Running Tests

```bash
cd engine/build

# Run all tests
ctest

# Run with verbose output
ctest -V

# Run specific test executable
./vayu_tests
```

Every **test preset** runs the suite multi-process (`ctest -j8`, wired once into
the hidden `test-base` test preset in `engine/CMakePresets.json`, which the
Windows presets narrow to `-j4`); a bare `ctest` or `./vayu_tests` runs serially.
Parallelism is safe because the test binary enters a private per-process scratch
directory before running, so the relative `test_*.db` files fixtures open never
collide between concurrently scheduled tests (see `engine/tests/main.cpp` and
`engine/tests/temp_database.hpp`). Override the job count with an explicit
`ctest --preset linux-dev -jN`.

8 is **twice** a hosted runner's four cores, deliberately. Most of the suite's
wall time is spent waiting - on localhost mock servers, and on the sleeps the
pacing and shutdown tests measure - not on CPU, so oversubscription keeps paying
well past the core count. Measured on a 4-core runner-sized box, all green:
278s serial, 78s at `-j4`, 55s at `-j8`, 47s at `-j12`, 42s at `-j16`, 40s at
`-j24`. It stops at 8 because the curve is flattening by then and a hosted
runner is noisier than an idle machine, with the wall-clock-budget tests
(`run_stop_test.cpp`, `run_shutdown_test.cpp`, `load_pacing_test.cpp`,
`rate_limit_test.cpp`, `monitor_test.cpp`) the ones that would pay for a wrong
guess - and widening a timing budget to afford a bigger number is not on the
table.

**On Windows the database tests never overlap each other.** A plain `-j4` there
took ~37 min against a ~6 min serial run - the same `-j4` that cut ubuntu from
3-5 min to 1m15s and macOS from ~4 min to 1m06s. The per-test durations said
why: a fast band of pure-logic suites, and a slow band that is exactly the
fixtures which open a scratch `Database`, where concurrent SQLite commits cost
more than the concurrency returns (the 25-250ms retry sleeps `os_win.c` answers
a sharing violation with, and - until #838 - a genuine `synchronous=FULL` flush
barrier, though not where this paragraph used to put it; see below). Moving the
scratch directories between volumes was tried and made no difference, and
Windows Defender is not a factor - GitHub's hosted Windows images ship with
real-time monitoring disabled - so do not re-litigate either without new
measurements.

**Where the flush barrier actually was (#838).** This section used to name
"the flush barrier `synchronous=FULL` issues per commit" as the cost, and that
was wrong about the steady state: `dbSynchronous` defaults to **Off**
(`constants::database::SYNCHRONOUS` is `0`), so a committed result has never
carried an fsync. What did carry one was everything a `Database` does *before*
`init` applies that setting - two `sync_schema` passes from the constructor and
a config seed that wrote its sixty-odd rows as sixty-odd separate transactions -
all of it on SQLite's own defaults, a rollback journal at `synchronous=FULL`.
Per process, once; and the suite is one process per test. So the barrier was
real, it was paid at open rather than per commit, and it was the engine paying
for durability its own configuration says it does not want. #838 applies the
engine's journal mode and `synchronous` to the first connection the constructor
opens, and makes the seed one transaction.

So the Windows presets run `-j4` with those tests holding a shared CTest
`RESOURCE_LOCK`: no two of them run at once, while everything else runs 4-wide
beside them. The locked suites are listed in `engine/tests/CMakeLists.txt`
(`vayu_scratch_database_suites`), which discovers the binary twice - once with a
gtest filter matching them, once with its negation - so the two halves partition
the suite exactly. Two configure-time guards keep the list honest: a name that
matches no test fails the configure, and so does a `tests/*_test.cpp` that
includes `temp_database.hpp` but contributes no locked suite. **The list is a
performance statement, not a correctness one** - `ctest -j` is safe on any
platform through the scratch directories alone, so a suite missing from it
contends rather than breaks.

Measured locally on a 4-core box (Debug, 2070 tests, green in all four runs):
299.6s serial, 84.8s at `-j4`, 58.6s at `-j8`, and 243.7s at `-j4` with the lock
forced on - the last being the model Windows runs. That ratio was the honest
ceiling of this approach: the locked group is 817 of the 2070 tests but **81% of
the serial wall**, because the route and load fixtures that dominate the suite's
duration all open a database. The six fixtures the earlier analysis measured on
Windows (197 tests, 57.2s, 19% of the wall here - within a point of the Windows
figures, which is what makes this box a usable proxy for the *shape* of the
suite) are only the visible tip of that group.

**What #838 took off that group**, measured on the same class of box (Debug,
`ctest -j1` over the locked filter only, all green):

| build | locked-group serial wall |
|---|---:|
| before | 281.5s (820 tests) |
| config seed in one transaction | 170.8s (822 tests) |
| plus the pragmas on the first connection | **146.0s** (823 tests) |

So the group's serial time - the floor the whole hybrid model sits on - is a
little under half what it was, and the seed is the larger of the two halves.

**What that turned into on CI**, first run after the change (32275928094), all
three legs green:

| leg | ctest step | before |
|---|---:|---:|
| ubuntu | 30s | ~1m15s |
| macOS | 53s | ~1m06s |
| **windows** | **2m32s** (2105 tests, 10 skipped, 0 failed) | 5m27s / 4m50s |

The Windows leg is the one this was aimed at, and it lands at roughly half of
the 4m40s-6m38s band its *serial* runs spanned - so the hybrid model is finally
faster than the serial one it replaced, rather than merely no slower.

Note what this does *not* change: the group is still locked on Windows. The
lock's justification is the `-j4` blow-up, and the number above says the group
got cheaper, not that it now survives overlapping - that is its own experiment.
Do not shrink `vayu_scratch_database_suites` without one.

**What CI measured on the hybrid model: 5m27s and 4m50s** on two runs of the
same tree (32249239500 and 32252015024), 2071 tests, 0 failures, 9 skipped. Both
sit inside the 4m40s-6m38s band the serial legs spanned, so **this is not a
speedup** - and with a baseline that noisy, two samples could not show one either
way. What they do establish is that the mechanism works: the same `-j4` that took
~37 min without the lock now finishes in the time serial used to take, which is
what the 81% number predicts and the reason to hold the expectation there rather
than at the ~2.5 min this was first scoped for. Getting a real speedup meant
making the database tests cheaper, which is issue #838 and the table above -
and which took the Windows leg to 2m32s, close to the ~2.5 min this whole line
of work was first scoped for.

Isolation is the **default** on every platform now, so a hand-run `ctest -j` is
safe wherever it happens; the Windows presets used to set
`VAYU_TEST_NO_SCRATCH_ISOLATION` (which skips the scratch directory entirely)
because a serial run has nothing to isolate from, and no preset sets it today.

**Do not "improve" the job count to `"jobs": 0`.** Only CMake 3.29+ reads 0 as
"one job per processor"; this project's floor is 3.25, where `ctest -j 0`
silently runs the suite *serially* - a config that looks parallel and is not.

### Test files are registered, and the build checks it

The `vayu_tests` sources are listed one by one in `engine/tests/CMakeLists.txt`
rather than globbed, so the set of files that gets built is visible in the
diff. The cost of that is a file which is added to `engine/tests/` and never
listed: it compiles into nothing, runs nothing, and says nothing about it -
`response_capture_test.cpp` sat unbuilt for ~140 commits that way, and one of
its assertions had been wrong since the day it was written (issue #668).

A guard beside the source list globs `tests/*_test.cpp` and fails configure
naming any file the list is missing. The glob is only the check - it never
becomes the source list - and it is declared `CONFIGURE_DEPENDS`, so adding a
file re-runs the check on the next `ninja` rather than waiting for someone to
reconfigure. The guard also fails if the glob matches nothing at all, since a
check that scans an empty set passes for the wrong reason.

## Development Tips

### Faster Rebuilds

`build.py` sets these up on its own at configure time - install the tool and
the next build picks it up, nothing to opt into:

1. **Ninja** is the generator in every preset - faster than Makefiles.
2. **ccache** (or sccache) on PATH becomes the compiler launcher
   (`CMAKE_<LANG>_COMPILER_LAUNCHER`), so a clean rebuild or a branch switch
   replays unchanged compiles out of the cache instead of re-running them.
   Detecting a launcher also turns the nlohmann precompiled header **off**
   (`CMAKE_DISABLE_PRECOMPILE_HEADERS=ON`): the two are mutually exclusive,
   because GCC's `.gch` is not byte-reproducible and the cache hashes it into
   every consuming translation unit's key, so any rebuild of the PCH
   invalidates the whole cache - a clean rebuild measured 11 hits out of 498
   compiles with the PCH on. [#805](https://github.com/athrvk/vayu/issues/805)
   already established the PCH only pays in regimes without a compile cache.
   Not on Windows, where the MSVC PCH makes compiles non-cacheable and a
   launcher costs bookkeeping for nothing - measured on the same issue.
3. **mold, else lld** on Linux links executables via `-fuse-ld=<linker>`
   (`ld.lld` on PATH is what GCC needs for lld, so that is what is probed).
   The Debug link of `vayu_tests` - one binary, ~150 objects, static gtest -
   is a large share of the incremental loop on the default bfd linker.
4. **The configure step is skipped on warm builds.** `cmake --preset` re-runs
   the vcpkg manifest check every time, seconds of pure overhead when nothing
   configure-level changed. `build.py` fingerprints what ninja's own re-run
   rule cannot replay (the preset files and the arguments above) and only
   configures when that moved; edits to `CMakeLists.txt` or `vcpkg.json` are
   already configure dependencies, which ninja re-runs CMake for itself.

### Debugging

1. Build in Debug mode: `cmake -B build -DCMAKE_BUILD_TYPE=Debug`
2. Use a sanitizer preset - `linux-asan` for lifetime bugs, `linux-tsan` for
   races. See [Sanitizers](#sanitizers)
3. Generate compile commands: `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` (enabled by default)

### The version string stays out of the widely-included headers

`DEFAULT_USER_AGENT` is declared in `include/vayu/core/user_agent.hpp`, which
includes nothing, and defined in `src/core/user_agent.cpp`, the one translation
unit that sees `VAYU_VERSION_STRING` for it.

That is a build-cache rule, not a style one (issue #659). It used to be a
`constexpr` in `core/constants.hpp` spelled `"Vayu/" VAYU_VERSION_STRING`, which
forced that header to include `vayu/version.hpp` - and `constants.hpp` is
reached transitively by essentially every TU, through `types.hpp`,
`utils/logger.hpp`, `utils/json.hpp` and `http/client.hpp`. So bumping `VERSION`
changed a header in every compile command's input and invalidated the whole
sccache, meaning **every release rebuilt the engine from scratch on all three
platforms**. With the declaration in front of it, a bump recompiles
`user_agent.cpp` plus the handful of files that include `vayu/version.hpp`
directly (`daemon.cpp`, `cli.cpp`, `http/client.cpp`, `http/server.cpp`,
`http/routes/health.cpp`).

`tests/version_isolation_test.cpp` is the guard: it scans the hub headers for
`vayu/version.hpp` and `VAYU_VERSION`, and asserts it read a non-empty file
first. Including `vayu/version.hpp` from a `.cpp` is fine, and from a header only
where that header is not itself broadly included.

### The C++ standard, and the probe that answers a bump

The engine is C++23 (`CMAKE_CXX_STANDARD 23`, `STANDARD_REQUIRED ON`), raised
from 20 by issue #901. Raising it is a decision about the **worst compiler in
the matrix**, not about the best: the three platforms ship library support years
apart, so "C++23 has `std::expected`" was not a fact about the build until each
of GCC, AppleClang and MSVC had been asked.

What the measurement settled, and what it means for the floor:

| | Ubuntu `g++` 13.3 | macOS AppleClang 21 | Windows MSVC 19.51 |
|---|---|---|---|
| `std::expected` | yes | yes | yes |
| `std::optional` (monadic) | yes | yes | yes |
| `std::format` (C++20) | yes | yes | yes |
| `std::move_only_function` | yes | **no** | yes |

The engine uses the first three. It does **not** use `std::move_only_function`,
however much `thread_pool.hpp`'s `std::function` queue would like to - libc++
has not shipped it, so on macOS it does not exist. Ubuntu pins no compiler: its
default GCC covers everything the engine adopted, and `g++-14` adds only
features that are not on the list (`std::print`, `std::ranges::to`, deducing
`this`). Re-run the probe before reaching for anything not in the table.

`scripts/cxx-feature-probe/` asks them. It is a standalone CMake project - one
tiny translation unit per feature, compiled *and linked* at a standard the
engine has not adopted, reporting a per-feature table:

```bash
cmake -S scripts/cxx-feature-probe -B /tmp/probe                       # default compiler
cmake -S scripts/cxx-feature-probe -B /tmp/probe -DCMAKE_CXX_COMPILER=g++-14
cmake -S scripts/cxx-feature-probe -B /tmp/probe -DVAYU_PROBE_STANDARD=26
```

There is no build step; the table lands in the configure log and in
`<build dir>/probe-results.md`. In CI it is the `C++ feature probe` workflow -
four legs (Ubuntu on its default `g++` and on `g++-14`, macOS on AppleClang,
Windows on MSVC), run from **Run workflow** and automatically on a pull request
that changes the probe. It gates nothing: an unavailable feature is the answer,
and the job stays green reporting it. The job fails only when the probe cannot
measure - which it checks for, rather than assuming, by asserting that the
requested dialect actually reached the compiler before it trusts a single
verdict.

Results are recorded on the issue that asked for them (#901 for C++23), not in
the repository, so no checked-in file can drift out of date against a runner
image that rolled last week. See `scripts/cxx-feature-probe/README.md`.

### Compiler warnings, and the three that are suppressed

The engine builds **warning-clean** on Linux and macOS, and a release build is
where that is measured - several of the analyses below only run once the
optimizer does. If a change adds a warning, fix it rather than leave it: the
count is the signal, and it is only useful while it is zero.

```bash
# The build the count is read off: release, tests included, from cold.
cmake --preset linux-prod -DVAYU_BUILD_TESTS=ON
cmake --build --preset linux-prod --clean-first 2>&1 | grep -c 'warning:'
```

The flags are on `vayu_warnings` in `engine/CMakeLists.txt` - `-Wall -Wextra
-Wpedantic` plus `-Wconversion`, `-Wsign-conversion`, `-Wdouble-promotion`,
`-Wformat=2` and `-Wnull-dereference` on GCC and clang, `/W4 /WX` on MSVC.

**A warning fails the build in CI** (`VAYU_WERROR`, default `OFF`). The engine
job passes `-DVAYU_WERROR=ON` on the Linux and macOS legs, which adds `-Werror`;
Windows needs no flag, because MSVC has always built `/WX`. It is off by default
so a work-in-progress local build is not blocked by a warning - run the count
above, or configure with `-DVAYU_WERROR=ON` to get exactly what CI gets. Setting
the legacy `VAYU_STRICT_BUILD` environment variable to a truthy value turns it on
too, so an existing local workflow keeps working. Both GCC/clang legs are gated
rather than only Linux: a diagnostic one compiler emits and the other does not is
precisely what the gate is for - the macOS SDK spells `NAN` as `__builtin_nanf`,
which made a line in vendored `quickjs.h` a `-Wdouble-promotion` error there and
nowhere else (vendored headers are `SYSTEM` includes now, so third-party code
cannot fail our build).

Three GCC 13 diagnostics fire only on code the engine did not write, and those
are suppressed - narrowly, one function at a time, through the macros in
`engine/include/vayu/utils/diagnostics.hpp`, which carry the reason and the
trace beside each one:

| Family | Where it comes from |
|--------|---------------------|
| `-Wdangling-reference` | GCC 13's ref-in/ref-out heuristic, on a test helper that indexes a caller-owned document and returns a reference into it |
| `-Wnull-dereference` | Inlined libstdc++: a `basic_streambuf` pointer GCC cannot prove non-null, and nlohmann's internal `swap` |
| `-Warray-bounds` / `-Wstringop-overflow` | GCC 13's string-concatenation family, which reasons about the 32-byte small-string buffer as though it were the whole object. One diagnostic under two names, so both are named together |

**Never widen these into `vayu_warnings`.** A `-Wno-...` there hides the next
genuine instance of the same family across the whole engine, which is the entire
value of having the flag on. A suppression that a code change could remove
should be that code change instead.

### Formatting

`.clang-format` at the repository root governs `engine/{src,include,tests}`.
`engine/vendor/` has a `DisableFormat: true` config of its own and is never
touched.

**Use clang-format 19.** It is pinned, in the `Engine formatting` job of
`.github/workflows/pr-tests.yml` and in
[CONTRIBUTING.md](https://github.com/athrvk/vayu/blob/master/CONTRIBUTING.md),
and the pin is load-bearing rather than tidy-mindedness: 39 of the 285 engine
sources format differently under clang-format 18 than under 19. Ubuntu 24.04
ships 18 by default, so `apt install clang-format-19` - the same major the
clang-tidy gate uses, so one LLVM install answers for both.

```bash
# Check, the way CI does
clang-format-19 --style=file --dry-run -Werror \
  $(git ls-files -- engine/src engine/include engine/tests | grep -E '\.(c|cpp|h|hpp)$')

# Fix
clang-format-19 --style=file -i <file>...
```

It runs in two places, and both of them can stop a change:

| Where | What it checks | What a difference does |
|-------|----------------|------------------------|
| `scripts/pre-commit` (install with `bash scripts/install-git-hooks.sh`) | The **whole** of every staged `engine/{src,include,tests}` source | Refuses the commit |
| `Engine formatting`, a job of its own in `.github/workflows/pr-tests.yml` | The **whole tree** under those three roots | Fails CI |

Unlike the two clang-tidy gates below, these two agree on scope, because
formatting has no backlog to grandfather - so the hook can be exactly as strict
as CI and no stricter, which is what keeps `--no-verify` from becoming a reflex
(#908). The hook looks for `clang-format-19` first and a plain `clang-format`
second - `apt install clang-format-19` leaves the plain name at Ubuntu's 18,
while Homebrew's LLVM 19 installs it under the plain name - and when neither is
a 19 it says so and checks nothing, on the same reasoning as the clang-tidy
probe: the pin is exact, so an answer from another major is a wrong answer
rather than a missing one. That two-name lookup is
[shared with the clang-tidy pass](#static-analysis), not duplicated in it.
`git clang-format --staged` is deliberately not used;
it formats the changed lines, and a staged file it called clean could still fail
this whole-file check.

The gate checks the **whole tree** - wider still than the clang-tidy gate
below, which lints the whole of every changed file but never parses an
unchanged one, because formatting never had a backlog to grandfather. Issue
#886 replaced an imported 2015 template with a config derived by measurement,
and bulk-formatted all 285 sources in one commit; that commit's SHA is in
`.git-blame-ignore-revs`, so `git blame` on a formatted file still attributes
lines to whoever wrote them:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs   # once, per clone
```

**Includes are sorted**, and the tree was already 99.8% sorted before the gate
landed, so this costs nothing and is one fewer thing for a reviewer to check by
hand. Exactly one include order in the engine is load-bearing and is pinned at
the site rather than by disabling the sorter: `engine/src/platform/high_resolution_timer.cpp`
wraps `<windows.h>` / `<timeapi.h>` in `// clang-format off`, because
`timeapi.h` uses types `windows.h` defines, does not compile standalone, and
sorts first alphabetically - a break only the Windows CI leg would catch. Pin a
second such case the same way; do not turn the sorter off for the tree.

Two other settings look like mistakes and are not; both are commented in
`.clang-format` itself. `ColumnLimit: 80` is paired with
`PenaltyExcessCharacter: 1`, which makes 80 a target rather than a wall -
raising the limit made the bulk diff two to three times worse, because a wider
limit re-joins line breaks the code chose by hand. And `ContinuationIndentWidth:
0` wraps arguments to the enclosing block indent, which is what the engine's
code is written to. That one was re-measured and **kept** (#940, closing #907):
`ContinuationIndentWidth: 4` rewrites 250 of the 288 non-vendor sources for
23,938 lines - 3.3x #886's whole bulk-format commit - and 180 of the 191 sources
touched in the last 60 engine commits, so it is today's code that disagrees with
it, not legacy. The table is in `.clang-format`'s header; the question is
closed.

### Static Analysis

clang-tidy runs in two places, and both of them can stop a change:

| Where | What it lints | What a finding does |
|-------|---------------|---------------------|
| `scripts/pre-commit` (install with `bash scripts/install-git-hooks.sh`) | The **whole** of every staged `.c/.cpp/.h/.hpp` file | Refuses the commit |
| `Lint changed engine sources`, in the engine job of `.github/workflows/pr-tests.yml` | The **whole** of every changed `engine/{src,include,tests}` **translation unit**, on Linux and Windows alike. Headers are never direct inputs | Fails CI |
| `Engine tidy scan` (`.github/workflows/engine-tidy-scan.yml`), **weekly** plus `workflow_dispatch` | The **whole tree**, on Linux and Windows both. Not a pull-request gate - the denominator no per-change gate can give | Fails the run |

The two rows answer different questions, which is why both exist. The gate
lints the files a change *touches*, and so can never say what an **untouched**
file holds; the scan says exactly that and nothing about any particular
change. Drift into the rest of the tree therefore cannot arrive through a
diff - it arrives when the ground moves: a runner image bumping its
clang-tidy, or a `.clang-tidy` edit changing what the checks mean. That is
what the weekly run is for, on `sanitizers.yml`'s model (Monday 11:00 UTC,
clear of the 06:00 and 09:00 that other workflows already use).

**Both legs, not just the one that had a backlog.** Windows is why the scan
was written (#1023), but the hole it fills is not Windows-specific: the gate
lints translation units and never a header (#940), so a **header-only pull
request is linted by no CI job at all** - it relies on the contributor's
pre-commit hook. A header that introduces findings across the sources
including it can reach master unlinted on either platform, and only a
whole-tree run finds it afterwards. Linux drifts too, more slowly: it pins
clang-tidy 19 from apt where Windows takes whatever LLVM its image ships.
`workflow_dispatch` still scans the single runner you pick, which keeps a
targeted re-measure cheap; the schedule takes both. macOS is absent because
the *gate* is (#940) - scanning a platform nothing gates would measure a
standard nothing holds.

**A weekly failure files an issue**, because a cron nobody watches reports
nowhere useful otherwise: the job summary and the uploaded artifact are read
by whoever opens the run, and on a Monday morning nobody opens the run.
GitHub's own notification for a failed schedule reaches only whoever last
edited the cron line, which is an accident of git history rather than a way to
reach a maintainer. So the scan does what the sanitizers do - plain GitHub
API, no model and no tokens - filing one `tidy-scan-failure` issue keyed on
the runner, and commenting on it rather than filing again while it stays red.
The body is the deduplicated finding table itself. It does **not** file on a
pull request (#970's reasoning): a reviewer is already watching those checks,
and the artifact is what they need.

**Note which legs the gate covers: Linux and Windows, not macOS.** The lint
step carries `runner.os != 'macOS'`, because clang-tidy 19 *and* 20 both die
there with an `llvm_unreachable` trap on the runner's AppleClang SDK - a
settled decision (#940), re-openable only by a Homebrew LLVM that survives
both heavy translation units. So a macOS-only diagnostic is unlinted on every
path, gate and scan alike; what that costs is small and measured (the engine's
macOS-conditional surface is four `#define`s with no statement in them).

A finding is a failure because `engine/.clang-tidy` sets
`WarningsAsErrors: '*'`; with that empty, clang-tidy prints every diagnostic it
found and still exits 0. That single setting is what both places read their
verdict from - do not re-state it as a `--warnings-as-errors` flag at a call
site, or the two can disagree about what counts.

**Both gate whole files - the promotion decided in #946.** The gates opened at
changed-*lines* scope (#885, aligned across the two in #902), and that scoping
had exactly one job: the engine had never been linted, most files carried
findings older than any current diff (`openapi_drafts.cpp` answered with nine
on an untouched tree), and whole-file gating then would have failed pull
requests for code they did not write. #928 paid that backlog down family by
family (#942-#946) to zero findings tree-wide, which removed the only argument
for scoping - and its waves measured what the scoping cost while it lasted:

- #979 found that retyping a constant created a finding on a line its diff
  never touched, which a changed-lines gate structurally cannot see.
- #946's batch-4 measurement made the gap concrete: a whole-file lint of one
  branch's 30 changed translation units reported **98** findings; the same lint
  filtered to the branch's changed lines reported **0**. CI passed, correctly,
  with 98 findings standing in the very files the pull request opened.

So every edited file is fully re-checked, forever: a finding anywhere in a file
a pull request touches is that pull request's to fix, or to `NOLINT` with the
reason at the site. A file nobody edits is still not re-parsed - the gate's
unit of cost stays the translation-unit parse - which is why the tree-wide
scan-guard tests (`reentrant_test.cpp`, `character_cast_test.cpp`,
`bounds_primitives_test.cpp`, `optional_assert_test.cpp`) keep their job of
holding *unedited* files to the spellings they pin.

**Both legs are promoted, and each waited for its own measurement** (#946
Linux, #1023 Windows). The zero above was measured on the Linux toolchain -
clang-tidy 19 over GCC compile commands, the only toolchain any #928 wave
scanned with - and #946's own pull request proved that a zero does not
transfer between legs: the first whole-file lint ever run on Windows reported
~85 findings in the touched files alone, none on a line the diff wrote.
Promoting a leg ahead of its measured zero is the original failure back again,
so the Windows leg kept changed-lines scope until #1023 measured what only it
could see, paid it down, and collapsed the branch. What that leg was carrying,
and what each class cost:

| Class | What it was | What #1023 did |
|-------|-------------|----------------|
| `cppcoreguidelines-pro-type-vararg` on every libcurl option call | The bulk of it - `curl_easy_setopt`, `curl_multi_setopt` and `curl_easy_getinfo` are variadic, and 121 sites called them directly | One typed primitive, `vayu/http/curl_options.hpp`, holding the single `NOLINT`. See `engine/CLAUDE.md` |
| `modernize-use-integer-sign-comparison` | A check that exists only in clang-tidy 20, which is what the Windows image ships against a floor of 19 | Fixed - the two cast-to-compare sites in `sse_stream.cpp` became `std::cmp_greater` |
| `cppcoreguidelines-owning-memory` | Windows-only code is code a Linux lint never compiles - the three `_dupenv_s` branches | Fixed at the site: the returned buffer is owned by a `unique_ptr` with `std::free` as its deleter, which retires the finding and closes a leak-on-throw at the same time |
| `bugprone-implicit-widening-of-multiplication-result` | `unsigned long` is 32-bit on Windows and 64-bit on Linux, so `32UL * 1024 * 1024` multiplies in a narrower type than the `size_t` it initialises. Harmless at today's values and silent overflow at tomorrow's | Fixed - the three constants multiply in `size_t` |
| `bugprone-exception-escape` | **Not a property of this code.** The check fires only on a `throw` it can see, and MSVC's STL inlines throws where the analyzer reaches them while libstdc++ hides them behind out-of-line functions. Measured: 33 findings on `windows-latest`, 0 on `ubuntu-latest`, same check, same tree, same commit | The genuine defects fixed (`~SseStreamManager`, `~Logger`, `daemon.cpp`'s `main`), then the check declined in `engine/.clang-tidy` with its reasoning. What settled it: `cli.cpp`'s and `tests/main.cpp`'s `main` each already catch `...` and return, and it reports them anyway |

**Why only Windows ever saw the vararg class**, since it reads like a
toolchain mystery and is not one: libcurl's type-checking macros are guarded
`#if !defined(__cplusplus)` ("the typechecker does not work in C++ (yet)"), so
they have never applied to this codebase. What C++ gets instead is
`curl_exactly_three_arguments`, an arity check, and that one is defined only
`#if defined(__STDC__) && (__STDC__ >= 1)`. GCC and Clang define `__STDC__`;
MSVC does not, absent `/Za`. So the identical source is a call inside a
system-header macro on Linux - which clang-tidy attributes to the header and
drops - and a plain call on Windows. Any toolchain reproduces the Windows
reading with `clang-tidy --extra-arg=-U__STDC__
--extra-arg=-Wno-builtin-macro-redefined`, which is the cheapest way to check
a libcurl change before it reaches CI.

**The whole-tree scan is a workflow, not a local ritual** (#1023). The Windows
measurement needs clang-tidy 20 over MSVC compile commands and so cannot run
on the Linux machine most of this work happens on. `Engine tidy scan`
(`.github/workflows/engine-tidy-scan.yml`) is that run: pick a runner, it
builds the tree, regenerates the compile database without the precompiled
header, lints every non-vendor translation unit whole-file with
`-header-filter` on the command line, and reports through
`.github/dedupe-tidy-findings.py` - deduplicated by (file, line, column,
check), with the translation-unit count beside it so the denominator is on the
record. It fails when the count is not zero, so a green run *is* the claim,
and it uploads the log, the report and the unit list either way. Run it when
`engine/.clang-tidy` changes, when a runner image moves its clang-tidy, or to
re-establish the zero after a paydown.

**"Clean" means the whole tree, headers included - and a scan has to be asked
for that** (#1013). `run-clang-tidy` reports nothing found in a header unless
`-header-filter` is passed **on the command line**: the `HeaderFilterRegex` in
`engine/.clang-tidy` does not supply it. Every number the #928 paydown worked
from before this was measured without it, so 50 findings sat in headers that no
report had ever counted - the same seam as "CI lints translation units, never a
header" (#940), reaching the measurement rather than the gate.

That is a gap in the *measurement*, not in the standard. A header is part of the
tree, the pre-commit hook lints one whenever a commit stages it, and #946's
"zero findings tree-wide" is not true of a tree whose headers were never read.
So the re-measure command is:

```bash
run-clang-tidy-19 -p engine/build -quiet \
  -header-filter='.*[/\\]engine[/\\](src|include|tests)[/\\].*' \
  -extra-arg=-Wno-ignored-gch <every non-vendor translation unit>
```

and its output is **deduplicated by (file, line, column, check)** before it is
counted, because a header finding is reported once per translation unit that
includes it - which is what made the wave-0 table read 11 `concurrency-mt-unsafe`
where 8 sites existed. `-extra-arg=-Wno-ignored-gch` is needed because the
build's precompiled header is GCC's (#912).

Two things this does **not** change. The gate still lints translation units,
never a header as an input, because a header has no `compile_commands.json`
entry and a guessed command emits `clang-diagnostic-error`s (#940) - though
since the #946 promotion removed the line filter, a header's findings do
surface through every changed translation unit that includes it
(`HeaderFilterRegex` applies); a header-only pull request still relies on the
hook, which lints a staged header directly. And `engine/src/runtime/` stays
out of scope in every count: its own `.clang-tidy` declines every check with a
written reason, so the findings a check-list override surfaces there are that
decision working, not a backlog.

**What the config enables is a decision, not a default** (#928): the families
that catch real defects - `bugprone-*`, `clang-analyzer-*`, `concurrency-*`,
`cert-*`, a curated `cppcoreguidelines-*` safety subset, `performance-*` - plus
the `readability-*`/`modernize-*` remainder after the style-motivated checks
were declined with a written reason each. `engine/.clang-tidy` is the single
source of truth for both lists and the reasons; it also documents the alias
rule (one name per defect - a `cert-*` alias of an enabled check is off so
nothing reports twice). Every enabled family is at zero tree-wide since #946's
close-out, and the whole-file gates are what hold an edited file there.

**An empty `catch` says so in words** (#944). `bugprone-empty-catch` is enabled,
and a comment does not satisfy it: the check reads only the keywords in its
`IgnoreCatchWithKeywords` option, so that option carries `@deliberate` beside
clang-tidy's own `@TODO`/`@FIXME`. A `catch` block that is meant to be empty
opens with that keyword and then says why - what the recovery is, and what the
caller sees instead of the exception. Without it the only way to a clean tree is
a `NOLINT` per site, which records nothing. The keyword is not an argument on its
own: a `catch` that cannot state a reason is swallowing an error, and the answer
there is to fix it or to log it, not to name it deliberate.

The scope has been aligned across the two gates twice, in opposite directions,
and the second one is where it settled. The hook opened stricter than CI -
whole staged files against a tree full of backlog, so a one-line edit to a
legacy file was refused a commit over findings CI would let through, and
`--no-verify` was the only way past it. #902 brought it down to CI's
changed-lines scope, because a hook that has to be bypassed to commit is
advisory in practice. #946 brought the hook and CI's Linux leg up to whole
files, because the backlog whose existence was the whole argument for line
scoping was gone there, and #1023 brought CI's Windows leg up behind it once
that leg's own backlog was measured and paid. The `VAYU_TIDY_FULL=1` escape
hatch went with the first promotion and `clang-tidy-diff.py` with the second -
whole-file linting is simply what all three do now, invoking clang-tidy
directly on each file with no line filter to compute.

**A bulk reformat is the one change this gate cannot price fairly**, and the
escape is a label. The gate's unit of cost is the translation-unit parse, and a
reformat touches a line in every file it rewrites, so the gate would parse one
translation unit per reformatted file - #886's 149-file bulk format made the
gate ask for 152 translation units and killed the job at its timeout.

So a pull request that is nothing but the formatter's output carries the
**`reformat-pr` label**, and the lint step does not run:

```yaml
if: >-
  runner.os != 'macOS'
  && !contains(github.event.pull_request.labels.*.name, 'reformat-pr')
```

A reviewer applies it, it is visible on the pull request, and the job summary
says the lint was skipped rather than leaving a green check to imply it ran.
Use it only for a reformat: the label excuses every engine line in the pull
request, so anything else in the same branch goes unlinted with it. Split the
reformat into its own pull request, which is what #886 did anyway.

**Applying the label does not re-trigger CI.** This workflow runs on
`pull_request`, whose default activity types are `opened`, `synchronize` and
`reopened` - labelling is none of them, so the run that is already on the pull
request keeps its old verdict. Apply the label, then **re-run the engine jobs**;
the summary flips to the skip line. Do not add `labeled`/`unlabeled` to the
trigger to avoid the re-run: the path labeler applies labels to every pull
request, so that would run the whole matrix a second time on all of them.

This replaced a commit walk that read the skip out of `.git-blame-ignore-revs`
at the pull request's own HEAD (#909's bootstrap, deleted by #940). The
declaration was an author-writable input to a gate, which needed a validator to
guard it, which had a blind spot of its own - three mechanisms for a problem
that happens about once a year. `.git-blame-ignore-revs` still gets the bulk
commit's SHA, for `git blame`, which is the only thing it is for.

**CI lints on Linux and Windows**, not Linux alone. clang-tidy analyses a
translation unit, so an `#ifdef _WIN32` branch is preprocessed away before a
Linux run sees it - `platform.hpp`'s per-OS split and the Windows-only blocks in
`client.cpp`, `event_loop_worker.cpp` and `temp_database.hpp` are code a
Linux-only lint could never reach.

**macOS is excluded**, and that is decided (#940) rather than pending: clang-tidy
19.1.7 and 20.1.8 both die there with SIGILL - an `llvm_unreachable` trap - part
way through the two heaviest translation units, which lint clean on both other
legs. Upstream clang cannot parse that runner's AppleClang 21 SDK, and two
consecutive majors failing the same way is not a version ladder worth climbing.
What that loses is small and measured: the engine's entire macOS-conditional
surface is four `#define`s in `platform.hpp` with no statement in them, so what
is actually missed is `clang-analyzer-*` over shared code as compiled against
libc++. Linting on two of three platforms is a common posture, and this one is
accepted, not tolerated - there is no open issue for it.

**The one condition that reopens it:** a Homebrew LLVM that survives both
translation units on the runner's current SDK. Test it by dropping the
`runner.os != 'macOS'` term from the step's `if`, and put it back if it traps.

Both pass `--allow-no-checks`, for `engine/src/runtime/` - its `.clang-tidy`
disables every check, and clang-tidy calls an empty check list a usage error
rather than a clean run, so the one exempt directory would otherwise be the only
one that fails.

**The CI gate lints translation units. A header is never an input** - on every
platform, decided in #940 (it was Windows-only, from #926). The pre-commit hook
is the gate that lints headers.

`compile_commands.json` has one entry per translation unit and none for a
`.hpp`, so clang-tidy synthesises a command for a header handed to it directly.
That command is a guess. On Linux it happens to find libstdc++; on Windows it
does not find the MSVC STL and the whole standard library fails to parse - `no
template named 'optional' in namespace 'std'` - which `WarningsAsErrors: '*'`
turns into a failed job.

A wrong synthesised command is worse than one leg failing: a
`clang-diagnostic-error` sprays from files nobody touched, and handing
clang-tidy a file the compilation database has no entry for is the only way
this tree produces a compiler error at all. The rejected alternative was
passing MSVC's include paths through (`--extra-arg=-imsvc...`): it buys one
more leg of header-as-input coverage, in exchange for toolchain plumbing that
breaks when a runner image moves.

**What this costs shrank with the promotions** (#946, #1023). Under the
changed-lines gate, `clang-tidy-diff.py` built one invocation per changed file with a
`-line-filter` naming only that file, and clang-tidy drops a diagnostic in any
file its filter does not list - so a changed header never reached the CI gate
through its consumers at all. With no line filter on the invocation, the
config's `HeaderFilterRegex` applies, and a header's findings surface through
every **changed** translation unit that includes it. What CI still loses is a
header-only pull request from a machine with no hook installed - the hook
lints a staged header directly, against the contributor's own build tree. To
lint one by hand, point clang-tidy at a consumer:

```bash
clang-tidy-19 --allow-no-checks -p engine/build engine/src/http/routes.cpp
```

**`readability-function-cognitive-complexity` is on** (#1021). It was declined
in #940 (closing #929) while it could not be honoured: the check anchors on the
*function declaration*, never on the line that made the function complex, so the
changed-lines gate could not report it against the diff that caused it. #928's
completion (#946) promoted both gates to whole-file scope, which met the
re-enable condition that decision attached, and #1021 paid what the enable then
cost before flipping it - **68 functions in `engine/src` were over the default
threshold of 25**, and each was split into named steps first, so the check went
on against a tree already at zero rather than handing an unrelated pull request
somebody else's refactor.

The issue's own count - "ten functions in the routes layer" - was a stale
snapshot; measured over the whole compile database at the enable it was 25 in
the routes layer and 43 in `core/`, `db/`, `utils/`, `http/`, `cli.cpp` and
`daemon.cpp`. `engine/tests` is not in scope and never was: its own
`.clang-tidy` has disabled this check since #928, because a gtest body is a long
straight-line arrange/act/assert with no extracted helpers on purpose, and the
check has no remedy for that shape which leaves the test readable.

What it means for a change from here: a function you edit is re-checked whole,
so one that grows past the threshold is that pull request's to split - which is
the same rule every other check in this config already carries under the
whole-file gate. The reason sits beside the check in `engine/.clang-tidy`.

### The precompiled header

The engine builds with a PCH, and clang-tidy replays the compile command that
uses it - but that PCH was written by the *build's* compiler. On Linux it is a
GCC `.gch` ("not a clang PCH file"); on macOS it is an AppleClang PCH that
Homebrew's clang 19 rejects as "a newer PCH format". Under the prod presets'
`-Werror` / `/WX` both are hard errors raised before any check filter, and
neither carries a line the diff filter could match, so every file fails.

The two gates handle it differently, on purpose:

- **CI** regenerates `compile_commands.json` with
  `-DCMAKE_DISABLE_PRECOMPILE_HEADERS=ON` before linting. That needs no
  knowledge of any compiler's PCH flags and is the only thing that fixes the
  macOS case. It is safe in place because ctest has already run, and it takes
  under a second.
- **The hook** passes `--extra-arg=-Wno-ignored-gch` on its own clang-tidy
  command line instead, which silences the GCC case only. Reconfiguring your
  build tree from a git hook would throw away your next incremental build.

  It is on the command line and **not** in `engine/.clang-tidy`, where it used
  to sit (issue #912). That file is read by both gates, and there the flag broke
  the one that never needed it: `compile_commands.json` has one entry per
  translation unit and so none for a `.hpp`, and on the command clang-tidy
  synthesises for a file it cannot look up, an `ExtraArgs` entry arrives in
  input position - `error: no such file or directory: '-Wno-ignored-gch'`,
  which `WarningsAsErrors: '*'` turns into a failed engine job for any pull
  request that touched a header. Anything only one gate needs belongs at that
  gate's call site.

Either way clang-tidy falls back to including the header as text and analyses
exactly the same translation unit.

Both need **clang-tidy 19 or newer**: `engine/.clang-tidy` uses
`ExcludeHeaderFilterRegex`, which landed in LLVM 19, and an older binary rejects
the config file and lints nothing. The hook probes the version and warns loudly
instead of exiting clean over an empty scan; a contributor without a current
clang-tidy loses the early warning, not the check.

The hook looks for `clang-tidy-19` first and a plain `clang-tidy` second, for
the reason the formatter does: `apt install clang-tidy-19` - the instruction the
warning itself gives - leaves the plain name at Ubuntu's 18, while Homebrew's
LLVM 19 and the Windows installer use the plain name. Probing only the plain
name meant the most common setup installed a 19, found the 18, and was told to
install a 19 (#918); the warning now names the nearest candidate it rejected, so
"you have an 18" reads differently from "you have nothing".

**One `find_llvm_tool` in `scripts/pre-commit` answers for both tools**, with
the comparison a parameter - `exact` for clang-format, whose pin is not a floor,
and `minimum` for clang-tidy, whose pin is. It is shared rather than copied
because that is precisely how the two halves came to disagree: the formatter
learned about the packaging split and the linter did not. `pre-commit_test.sh`
pins the sharing as well as the behaviour.

CI's version differs per leg, and none of it is a free choice:

| Leg | clang-tidy | Why |
|-----|-----------|-----|
| Linux | 19, from apt | What CONTRIBUTING.md tells contributors to install, so a local run and CI answer the same |
| Windows | 20.1.8, shipped by the image | chocolatey refuses to downgrade from the preinstalled version, and the image's copy costs no install time |

The step asserts the 19 floor rather than trusting it, because a runner image
is a pin somebody else controls. The cost of the spread is that a finding on one
leg alone may be a version difference rather than a platform one - worth knowing
when you read a failure, and much cheaper than having no coverage of the per-OS
branches at all.

To lint by hand, point clang-tidy at a configured build tree:

```bash
python build.py -e                       # writes engine/build/compile_commands.json
clang-tidy-19 --allow-no-checks -p engine/build engine/src/http/routes.cpp

# Or exactly what CI does, against your own changes (#946: whole changed files):
git diff --name-only master... -- engine/src engine/include engine/tests \
  | grep -E '\.(c|cpp)$' \
  | xargs -n 1 -P "$(nproc)" clang-tidy-19 --allow-no-checks -p engine/build
```

clang-tidy is deliberately **not** wired into the build itself. A
`CMAKE_CXX_CLANG_TIDY` block sat commented out in `engine/CMakeLists.txt` for
years: a lint that runs only when someone uncomments it never runs, and
uncommenting it re-lints the whole tree on every build. Issue #885 removed it in
favour of the two gates above.

## Troubleshooting

### vcpkg Not Found

Set `VCPKG_ROOT` environment variable or install vcpkg in a standard location.

### QuickJS Build Errors

- Ensure `engine/vendor/quickjs-ng/CMakeLists.txt` exists (all platforms build
  the same vendored QuickJS-NG)

### Linker Errors

- Ensure all vcpkg dependencies are installed: `vcpkg install curl[core,http2,non-http,openssl] libsodium nlohmann-json ryml valijson cpp-httplib[openssl] sqlite3 sqlite-orm gtest`
  (the leading `core` is what `default-features: false` spells on the command line, and it is load-bearing on Windows - see the dependency table above. `http2` is required, without it libcurl is built without nghttp2 and the HTTP/2 support test fails; `non-http` is a default feature the engine relies on and has to be named once the defaults are off; cpp-httplib's `openssl` is required for the same reason one step further along - without it `httplib::SSLServer` does not exist and the TLS-verification tests do not compile)
- On Windows, ensure Visual Studio C++ tools are installed

### Build Script Issues

The build script (`build.py`) handles:
- Cross-platform compatibility (Windows/Linux/macOS)
- vcpkg detection (including Visual Studio bundled vcpkg on Windows)
- CMake detection (including Visual Studio bundled CMake)
- Platform-specific compiler flags via CMakePresets

If issues persist, try manual CMake build with presets as shown above.

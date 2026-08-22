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
- **C++ Compiler**: C++20 compatible
  - Clang 15+ (recommended)
  - GCC 12+
  - MSVC 2022+ (Windows)
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

`linux-asan` is a separate tree rather than a flag on `linux-dev`, so an ASan
run never invalidates the ordinary build's objects. It is the tool for a
**lifetime** bug - a crash the ordinary suite only produces intermittently and
without an assertion failure, which is what a use-after-free across threads
looks like. Two things worth knowing when you reach for it:

- Run the suspect tests **under load**, not alone. Issue #646 was a worker
  thread writing through a `Database` its fixture had already destroyed; it
  passed 5/5 in isolation and reproduced on every attempt with four copies of
  the binary running concurrently (each from its own working directory, since
  the fixtures write scratch `test_*.db` files into it).
- `ASAN_OPTIONS=detect_leaks=0` keeps the report to the memory error itself.

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

# Enable ThreadSanitizer (debug builds)
cmake -B build -DCMAKE_BUILD_TYPE=Debug -DVAYU_USE_TSAN=ON

# Treat compiler warnings as errors (what CI does)
cmake -B build -DVAYU_WERROR=ON
```

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
  `brew install llvm` clang-tidy is found without touching `PATH` yourself

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
beside them. The locked suites are listed in `engine/CMakeLists.txt`
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

The `vayu_tests` sources are listed one by one in `engine/CMakeLists.txt`
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

1. Use Ninja generator (faster than Makefiles)
2. Use ccache if available (auto-detected by build script)
3. Use mold linker on Linux (auto-detected by build script)

### Debugging

1. Build in Debug mode: `cmake -B build -DCMAKE_BUILD_TYPE=Debug`
2. Use AddressSanitizer: `-DVAYU_USE_ASAN=ON`
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

### Static Analysis

clang-tidy runs in two places, and both of them can stop a change:

| Where | What it lints | What a finding does |
|-------|---------------|---------------------|
| `scripts/pre-commit` (install with `bash scripts/install-git-hooks.sh`) | Whole staged `.c/.cpp/.h/.hpp` files | Refuses the commit |
| `Lint changed engine sources`, in the engine job of `.github/workflows/pr-tests.yml` | The **changed lines** of `engine/{src,include,tests}` sources, on all three platforms | Fails CI |

A finding is a failure because `engine/.clang-tidy` sets
`WarningsAsErrors: '*'`; with that empty, clang-tidy prints every diagnostic it
found and still exits 0. That single setting is what both places read their
verdict from - do not re-state it as a `--warnings-as-errors` flag at a call
site, or the two can disagree about what counts.

**CI gates the changed lines, not the changed files**, through LLVM's own
`clang-tidy-diff.py`. The engine had never been linted, so most files carry
findings older than any current diff - `openapi_drafts.cpp` answered with nine
on an untouched tree. Gating whole files would fail a pull request for code it
did not write, in every file it happened to open. New code is held to the config
from its first line; the backlog is paid down by whoever edits those lines.

The pre-commit hook is the stricter of the two: it lints whole staged files, so
it reports the backlog as well. That is deliberate for a local early warning you
can skip with `git commit --no-verify`, and it is why a hook refusal is not by
itself a merge blocker. Issue #902 tracks aligning the two.

**CI lints on all three platforms**, not just Linux, and pins the same
clang-tidy major on each. clang-tidy analyses a translation unit, so every
`#ifdef _WIN32` and `__APPLE__` branch is preprocessed away before a Linux run
sees it - `platform.hpp`'s four-way split, and the Windows-only blocks in
`client.cpp`, `event_loop_worker.cpp` and `temp_database.hpp`, are code no
Linux-only lint could reach. Pinning one major matters more here than it does
for a single leg: three legs on three clang-tidy versions would report version
differences as platform differences.

Both pass `--allow-no-checks`, for `engine/src/runtime/` - its `.clang-tidy`
disables every check, and clang-tidy calls an empty check list a usage error
rather than a clean run, so the one exempt directory would otherwise be the only
one that fails.

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
- **The hook** sets `ExtraArgs: ['-Wno-ignored-gch']` in `engine/.clang-tidy`
  instead, which silences the GCC case only. Reconfiguring your build tree from
  a git hook would throw away your next incremental build.

Either way clang-tidy falls back to including the header as text and analyses
exactly the same translation unit.

Both need **clang-tidy 19 or newer**: `engine/.clang-tidy` uses
`ExcludeHeaderFilterRegex`, which landed in LLVM 19, and an older binary rejects
the config file and lints nothing. The hook probes the version and warns loudly
instead of exiting clean over an empty scan; a contributor without a current
clang-tidy loses the early warning, not the check.

CI's version differs per leg, and none of it is a free choice:

| Leg | clang-tidy | Why |
|-----|-----------|-----|
| Linux | 19, from apt | What CONTRIBUTING.md tells contributors to install, so a local run and CI answer the same |
| macOS | 20, shipped by the image | 19 crashed with SIGILL on a runner that builds with AppleClang 21 |
| Windows | 20.1.8, shipped by the image | chocolatey refuses to downgrade from the preinstalled version |

The step asserts the 19 floor rather than trusting it, because a runner image
is a pin somebody else controls. The cost of the spread is that a finding on one
leg alone may be a version difference rather than a platform one - worth knowing
when you read a failure, and much cheaper than having no coverage of the per-OS
branches at all.

To lint by hand, point clang-tidy at a configured build tree:

```bash
python build.py -e                       # writes engine/build/compile_commands.json
clang-tidy-19 --allow-no-checks -p engine/build engine/src/http/routes.cpp

# Or exactly what CI does, against your own changes:
git diff -U0 master... -- engine/src engine/include engine/tests \
  | clang-tidy-diff-19.py -clang-tidy-binary clang-tidy-19 \
      -p1 -path engine/build -quiet -allow-no-checks -j "$(nproc)"
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

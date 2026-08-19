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
| curl | HTTP client library |
| libsodium | SHA-256, HMAC-SHA256, base64 and hex (PKCE, Basic/OAuth credentials, `pm.crypto`) |
| nlohmann-json | JSON parsing/serialization |
| valijson | JSON Schema validation of responses against a bound OpenAPI document |
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
- Homebrew LLVM paths are automatically detected for clang-tidy

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
`engine/CMakeLists.txt`. **Without it, HTTP/2 is impossible on Windows** - not
slower, not intermittent: never negotiated, with a `200 OK` and a reported
`HTTP/1.1` for a request that asked for h2.

The chain, because no part of it is guessable from the flag:

1. libcurl on Windows uses the Schannel TLS backend, and HTTP/2 over TLS is
   only reachable through ALPN.
2. curl's Schannel backend enables ALPN only when the OS is at least Windows
   8.1 (`s_win_has_alpn`, `lib/vtls/schannel.c`).
3. That check prefers ntdll's `RtlVerifyVersionInfo`, which tells the truth -
   but resolves the pointer to it in `Curl_win32_init()`, which libcurl's
   `global_init()` runs *after* `Curl_ssl_init()`. The one call that decides
   ALPN for the whole process therefore falls back to `VerifyVersionInfoW`.
4. `VerifyVersionInfoW` is version-shimmed: since Windows 8.1 it reports 6.2 to
   any process whose manifest does not declare support for a later OS. 6.2 <
   6.3, so ALPN is switched off for the life of the process.

The manifest's `supportedOS` ids turn the shim off. v0.11.0 through v0.14.0
shipped without it and HTTP/2 was dead on Windows the whole time
([#215](https://github.com/athrvk/vayu/issues/215)) - the failure is invisible,
which is why it is guarded twice: `HttpVersionSupport.WindowsOsVersionIsNotShimmed`
asserts that the test binary is not being version-lied to, and
`check-windows-deps.py` scans the *shipped* `vayu-engine.exe` for the ids, since
a gtest can only vouch for the process it runs in.

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
more than the concurrency returns (the flush barrier `synchronous=FULL` issues
per commit, and the 25-250ms retry sleeps `os_win.c` answers a sharing violation
with). Moving the scratch directories between volumes was tried and made no
difference, and Windows Defender is not a factor - GitHub's hosted Windows
images ship with real-time monitoring disabled - so do not re-litigate either
without new measurements.

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
forced on - the last being the model Windows runs. That ratio is the honest
ceiling of this approach: the locked group is 817 of the 2070 tests but **81% of
the serial wall**, because the route and load fixtures that dominate the suite's
duration all open a database. The six fixtures the earlier analysis measured on
Windows (197 tests, 57.2s, 19% of the wall here - within a point of the Windows
figures, which is what makes this box a usable proxy for the *shape* of the
suite) are only the visible tip of that group.

**What CI measured on the hybrid model: 5m27s and 4m50s** on two runs of the
same tree (32249239500 and 32252015024), 2071 tests, 0 failures, 9 skipped. Both
sit inside the 4m40s-6m38s band the serial legs spanned, so **this is not a
speedup** - and with a baseline that noisy, two samples could not show one either
way. What they do establish is that the mechanism works: the same `-j4` that took
~37 min without the lock now finishes in the time serial used to take, which is
what the 81% number predicts and the reason to hold the expectation there rather
than at the ~2.5 min this was first scoped for. Getting a real speedup means
making the database tests cheaper to run concurrently, which is issue #838; treat
that as the open work, not this paragraph as a win.

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

### Static Analysis

The pre-commit hook (`scripts/pre-commit`, installed by
`bash scripts/install-git-hooks.sh`) needs **clang-tidy 19 or newer**:
`engine/.clang-tidy` uses `ExcludeHeaderFilterRegex`, which landed in LLVM 19,
and an older binary rejects the config file and lints nothing. The hook probes
the version and warns loudly instead of exiting clean over an empty scan; CI
lints on a current toolchain either way.

Enable clang-tidy in `CMakeLists.txt` (commented out by default):

```cmake
find_program(CLANG_TIDY_EXE NAMES "clang-tidy")
if(CLANG_TIDY_EXE)
    set(CMAKE_CXX_CLANG_TIDY "${CLANG_TIDY_EXE}")
endif()
```

## Troubleshooting

### vcpkg Not Found

Set `VCPKG_ROOT` environment variable or install vcpkg in a standard location.

### QuickJS Build Errors

- Ensure `engine/vendor/quickjs-ng/CMakeLists.txt` exists (all platforms build
  the same vendored QuickJS-NG)

### Linker Errors

- Ensure all vcpkg dependencies are installed: `vcpkg install curl[http2] libsodium nlohmann-json valijson cpp-httplib[openssl] sqlite3 sqlite-orm gtest`
  (the `http2` feature is required - without it libcurl is built without nghttp2 and the HTTP/2 support test fails; the `openssl` feature is required for the same reason one step further along - without it `httplib::SSLServer` does not exist and the TLS-verification tests do not compile)
- On Windows, ensure Visual Studio C++ tools are installed

### Build Script Issues

The build script (`build.py`) handles:
- Cross-platform compatibility (Windows/Linux/macOS)
- vcpkg detection (including Visual Studio bundled vcpkg on Windows)
- CMake detection (including Visual Studio bundled CMake)
- Platform-specific compiler flags via CMakePresets

If issues persist, try manual CMake build with presets as shown above.

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
```

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
| cpp-httplib | HTTP server library |
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

## Development Tips

### Faster Rebuilds

1. Use Ninja generator (faster than Makefiles)
2. Use ccache if available (auto-detected by build script)
3. Use mold linker on Linux (auto-detected by build script)

### Debugging

1. Build in Debug mode: `cmake -B build -DCMAKE_BUILD_TYPE=Debug`
2. Use AddressSanitizer: `-DVAYU_USE_ASAN=ON`
3. Generate compile commands: `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` (enabled by default)

### Static Analysis

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

- Ensure all vcpkg dependencies are installed: `vcpkg install curl[http2] libsodium nlohmann-json cpp-httplib sqlite3 sqlite-orm gtest`
  (the `http2` feature is required - without it libcurl is built without nghttp2 and the HTTP/2 support test fails)
- On Windows, ensure Visual Studio C++ tools are installed

### Build Script Issues

The build script (`build.py`) handles:
- Cross-platform compatibility (Windows/Linux/macOS)
- vcpkg detection (including Visual Studio bundled vcpkg on Windows)
- CMake detection (including Visual Studio bundled CMake)
- Platform-specific compiler flags via CMakePresets

If issues persist, try manual CMake build with presets as shown above.

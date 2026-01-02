# Building Vayu Engine from Source
cd vayu/engine
# Building Vayu Engine from Source

**Version:** 1.0  
**Last Updated:** January 2, 2026

---

## One-Command Workflow (Recommended)

Use the provided script; it handles configure, build, deps, and tests:

```bash
./scripts/build-and-test.sh           # Release build + tests
./scripts/build-and-test.sh -d        # Debug build
./scripts/build-and-test.sh -c        # Clean build
./scripts/build-and-test.sh -s        # Build only, skip tests
./scripts/build-and-test.sh -t        # Tests only (reuse existing build)
./scripts/build-and-test.sh --setup-deps  # Bootstrap vcpkg deps (macOS/Linux)
```

**Prereqs:** CMake 3.25+, C++20 compiler, git. The script will guide you if vcpkg is missing.

---

## Outputs

After the script finishes:

- `engine/build/vayu-cli` — CLI tool
- `engine/build/vayu-engine` — Daemon
- `engine/build/vayu_tests` — Test runner

---

## Running Tests

Script default runs tests. To rerun manually on an existing build:

```bash
ctest --test-dir engine/build --output-on-failure
```

Run a specific suite:

```bash
ctest --test-dir engine/build --output-on-failure -R "ScriptEngineTest|EventLoopTest"
```

See [scripting.md](scripting.md) for test script examples (fixtures in `tests/fixtures/*.json`).

---

## Troubleshooting (Script-First)

- **vcpkg missing**: run `./scripts/build-and-test.sh --setup-deps`
- **Network-sensitive tests**: some tests hit `httpbin.org` and `sse.dev`; use `-s` to skip tests or `ctest ... --timeout 60`
- **Verbose build**: `./scripts/build-and-test.sh -v`

For manual CMake knobs (ASan/TSan, component builds), see `./scripts/build-and-test.sh --help`.
# Event loop tests
ctest --test-dir build --output-on-failure -R "EventLoopTest"

# Script engine tests
ctest --test-dir build --output-on-failure -R "ScriptEngineTest"

# SSE parser tests
ctest --test-dir build --output-on-failure -R "SseParserTest"

# Database tests
ctest --test-dir build --output-on-failure -R "DatabaseTest"
```

### Test Coverage

| Component | Test File | Test Count | Coverage |
|-----------|-----------|-----------|----------|
| HTTP Client | `http_client_test.cpp` | 9 | Request/response, timeouts, redirects |
| Event Loop | `event_loop_test.cpp` | 10 | Submit, batch, cancel, stats tracking |
| SSE Parser | `sse_test.cpp` | 18 | Parsing, chunked input, multi-line data |
| Script Engine | `script_engine_test.cpp` | 30 | pm.test(), pm.expect(), assertions |
| Thread Pool | (event_loop_test.cpp) | 6 | Batch execution, concurrency |
| Database | `db_test.cpp` | 10+ | CRUD, schema, persistence |
| JSON Utils | `json_test.cpp` | 16 | Parse, serialize, validation |
| **Total** | | **96+** | **✅ All Passing** |

### Debug With Output

Run tests directly without ctest for interactive debugging:

```bash
# Run test executable directly (shows all output)
./build/vayu_tests

# Run specific test (gtest filter)
./build/vayu_tests --gtest_filter="ScriptEngineTest.PmTestPassing"

# Show all test names
./build/vayu_tests --gtest_list_tests
```

### Test Fixtures

Some tests require network access to external services:

- `https://httpbin.org/` - General HTTP testing
- `https://sse.dev/test` - SSE endpoint testing

If network is unavailable, these tests will timeout and fail. For offline development:
1. Comment out network-dependent tests
2. Or provide mock endpoints locally

### Script Files and Examples

- CLI request/test samples live in `tests/fixtures/*.json` (used by `run` and `batch` commands)
- Scripting API reference: see [scripting.md](scripting.md) for `pm` object, assertions, and console usage
- Quick start request with tests:

```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "tests": "pm.test('Status is 200', () => pm.expect(pm.response.code).to.equal(200));"
}
```

### Building with Sanitizers

Detect memory leaks and thread issues:

```bash
# Build with Address Sanitizer (memory issues)
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
  -DVAYU_USE_ASAN=ON \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake

# Build with Thread Sanitizer (data races)
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
  -DVAYU_USE_TSAN=ON \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake

# Run tests - sanitizer output goes to stderr
./build/vayu_tests
```

---

## CMake Configuration Options

Customize the build with these flags:

### Build Type

```bash
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug|Release|RelWithDebInfo
```

| Mode | Optimization | Symbols | Use Case |
|------|--------------|---------|----------|
| Debug | None | Yes | Development, debugging |
| Release | Full (-O3) | No | Production deployment |
| RelWithDebInfo | Full (-O3) | Yes | Production with debugging |

### Component Options

```bash
# Enable/disable test suite
cmake -B build -DVAYU_BUILD_TESTS=ON|OFF

# Enable Address Sanitizer (memory debugging)
cmake -B build -DVAYU_USE_ASAN=ON|OFF

# Enable Thread Sanitizer (data race detection)
cmake -B build -DVAYU_USE_TSAN=ON|OFF
```

### Full Custom Build

```bash
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DVAYU_BUILD_TESTS=ON \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

---

## Component Details

### Vayu CLI (`vayu-cli`)

**What it is:** Thin client for single requests and batch operations

**Build target:** `vayu-cli`

**Binary:** `build/vayu-cli`

**Usage:**
```bash
./build/vayu-cli run request.json
./build/vayu-cli batch *.json --concurrency 10
```

**Key files:**
- `src/main.cpp` - CLI entry point
- `src/http/client.cpp` - HTTP implementation
- `include/vayu/http/client.hpp` - Client interface

### Vayu Engine (`vayu-engine`)

**What it is:** Daemon providing HTTP control API on port 9876

**Build target:** `vayu-engine`

**Binary:** `build/vayu-engine`

**Usage:**
```bash
./build/vayu-engine &  # Start daemon
curl http://127.0.0.1:9876/health  # Test connection
```

**Key files:**
- `src/daemon.cpp` - Daemon entry point and HTTP server
- `src/http/server.cpp` - HTTP server endpoints
- `src/http/event_loop.cpp` - Async request execution
- `src/db/database.cpp` - SQLite persistence

### Test Suite (`vayu_tests`)

**What it is:** Comprehensive test executable with 96+ tests

**Build target:** `vayu_tests`

**Binary:** `build/vayu_tests`

**Run:**
```bash
./build/vayu_tests --gtest_filter="*"
```

---

## Dependencies

All dependencies are managed by vcpkg. See `vcpkg.json`:

| Library | Version | Purpose |
|---------|---------|---------|
| libcurl | 8.x | HTTP client with SSL/TLS |
| nlohmann-json | 3.x | JSON parsing/serialization |
| quickjs | 2024+ | JavaScript engine |
| fmt | 11.x | String formatting |
| gtest | 1.14+ | Unit testing (dev only) |
| httplib | 0.x | HTTP server |
| sqlite3 | 3.x | Database |
| sqlite-orm | 1.x | C++ ORM |

### Manual Dependency Installation

If vcpkg integration fails, install manually:

**macOS:**
```bash
brew install curl nlohmann-json fmt openssl

# QuickJS must be built from source or vcpkg
```

**Linux:**
```bash
sudo apt install libcurl4-openssl-dev nlohmann-json3-dev libfmt-dev openssl-dev

# QuickJS from vcpkg or source
```

---

## Common Build Issues

### "vcpkg not found"

Make sure `VCPKG_ROOT` is set:

```bash
export VCPKG_ROOT="$HOME/.vcpkg"
# Or on Windows:
# $env:VCPKG_ROOT = "C:\vcpkg"
```

### "QuickJS not found"

QuickJS is compiled from source. This requires:
- C compiler (gcc, clang, MSVC)
- Make (on Unix) or build system of choice

The build should auto-download and compile. If it fails:

```bash
cd engine/vendor/quickjs
make -f Makefile  # Build standalone
```

### "ninja: command not found"

Install ninja or use Make instead:

```bash
# Install ninja
brew install ninja  # macOS
sudo apt install ninja-build  # Linux

# Or use Unix Makefiles
cmake -B build -G "Unix Makefiles"
```

### Test Timeouts

If tests hang (especially network tests), increase timeout:

```bash
ctest --test-dir build --output-on-failure --timeout 60
```

Or run without network-dependent tests:

```bash
./build/vayu_tests --gtest_filter="-*IntegrationTest"
```

---

## Installation (After Build)

Install binaries to system path:

```bash
cmake --install build --prefix "$HOME/.local"

# Then use globally
~/.local/bin/vayu-cli --help
~/.local/bin/vayu-engine &
```

Or for system-wide install:

```bash
sudo cmake --install build --prefix "/usr/local"

# Use globally
vayu-cli --help
vayu-engine &
```

---

## Troubleshooting

### Verbose Build Output

See actual compiler commands:

```bash
cmake --build build --verbose
```

### Rebuild Everything

```bash
rm -rf build
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build build
```

### View Warnings

```bash
cmake --build build --output-on-warning 2>&1 | grep -i warning
```

### Profile Build Time

```bash
time cmake --build build  # Total time
cmake --build build -- -d stats  # Per-target time (Ninja)
```

---

*See: [Architecture](architecture.md) | [API Reference](api-reference.md) | [CLI Reference](cli.md) →*---

## CMake Options

| Option | Default | Description |
|--------|---------|-------------|
| `CMAKE_BUILD_TYPE` | `Debug` | `Debug`, `Release`, `RelWithDebInfo` |
| `VAYU_BUILD_TESTS` | `ON` | Build test suite |
| `VAYU_BUILD_CLI` | `ON` | Build CLI tool |
| `VAYU_BUILD_ENGINE` | `ON` | Build daemon |
| `VAYU_USE_ASAN` | `OFF` | Enable AddressSanitizer |
| `VAYU_USE_TSAN` | `OFF` | Enable ThreadSanitizer |

### Example: Debug with ASAN

```bash
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
  -DVAYU_USE_ASAN=ON \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build build
```

---

## Development Workflow

### Build Engine

```bash
cd engine

# Configure debug build
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake

# Build
cmake --build build

# Run tests
ctest --test-dir build --output-on-failure
```

### Rebuild After Changes

```bash
cd engine/build
ninja  # Faster incremental rebuild
```

---

## Troubleshooting

### CMake Can't Find vcpkg

```
CMake Error: Could not find toolchain file
```

**Solution:**
```bash
export VCPKG_ROOT=~/.vcpkg
```

---

### libcurl SSL Errors on macOS

```
curl: (60) SSL certificate problem
```

**Solution:**
```bash
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCURL_USE_SECTRANSPORT=ON \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

---

### Build Fails on Apple Silicon

```
error: building for macOS-arm64 but attempting to link with file built for macOS-x86_64
```

**Solution:**
```bash
rm -rf build
cmake -B build -G Ninja \
  -DCMAKE_OSX_ARCHITECTURES="arm64" \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

---

## IDE Setup

### VS Code

Install extensions:
- C/C++ (Microsoft)
- CMake Tools

`.vscode/settings.json`:
```json
{
  "cmake.configureArgs": [
    "-DCMAKE_TOOLCHAIN_FILE=${env:VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake"
  ],
  "cmake.generator": "Ninja"
}
```

### CLion

1. Open `engine/` as CMake project
2. Settings → Build → CMake:
   - CMake options: `-DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake`
   - Generator: Ninja

---

*← [Getting Started](../getting-started.md) | [API Reference](api-reference.md) →*

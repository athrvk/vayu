# Building Vayu Engine

## Quick Build

From the project root:

```bash
# Release build + tests
./scripts/build/build-and-test.sh

# Debug build + tests
./scripts/build/build-and-test.sh -d

# Skip tests
./scripts/build/build-and-test.sh -s

# Clean build
./scripts/build/build-and-test.sh -c

# Custom job count
./scripts/build/build-and-test.sh -j 8
```

## Prerequisites

- **CMake**: 3.25 or higher
- **C++ Compiler**: C++20 compatible
  - Clang 15+ (recommended)
  - GCC 12+
  - MSVC 2022+ (Windows)
- **vcpkg**: Package manager (auto-detected or install separately)
- **Ninja**: Build system (optional, but recommended for faster builds)

## Manual Build

### Configure

```bash
cd engine

# Release build with Ninja (recommended)
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release

# Debug build
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug

# Without Ninja (uses default generator)
cmake -B build -DCMAKE_BUILD_TYPE=Release
```

### Build

```bash
# With Ninja
ninja -C build

# Without Ninja
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

### Linux

- Uses original QuickJS (vendored in `engine/vendor/quickjs`)
- Requires development headers: `libcurl-dev`, `sqlite3-dev`
- Recommended: Use Ninja for faster builds

### macOS

- Uses original QuickJS (vendored)
- Requires Xcode Command Line Tools
- Homebrew LLVM paths are automatically detected for clang-tidy

### Windows

- Uses QuickJS-NG (MSVC-compatible fork in `engine/vendor/quickjs-ng`)
- Requires Visual Studio 2022 or later
- Uses vcpkg for all dependencies
- CMake generator defaults to Visual Studio solution

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

- **Linux/macOS**: Ensure `engine/vendor/quickjs/quickjs.c` exists
- **Windows**: Ensure `engine/vendor/quickjs-ng/CMakeLists.txt` exists

### Linker Errors

- Ensure all vcpkg dependencies are installed: `vcpkg install curl nlohmann-json cpp-httplib sqlite3 sqlite-orm gtest`
- On Windows, ensure Visual Studio C++ tools are installed

### Build Script Issues

The build script (`build-and-test.sh`) handles:
- vcpkg detection and dependency installation
- Optimal job count detection
- Platform-specific compiler flags
- Ninja/ccache/mold auto-detection

If issues persist, try manual CMake build as shown above.

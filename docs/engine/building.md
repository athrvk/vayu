# Building Vayu Engine

## Quick Build

```bash
# From project root
./scripts/build-and-test.sh      # Release build + tests
./scripts/build-and-test.sh -d   # Debug build + tests
./scripts/build-and-test.sh -s   # Skip tests
```

## Prerequisites

- CMake 3.25+
- Ninja
- C++20 compiler (Clang 15+ or GCC 12+)
- vcpkg (auto-installed by build script)

## Manual Build

```bash
cd engine
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
ninja -C build
```

## Build Outputs

```
engine/build/
├── vayu-engine    # HTTP daemon
├── vayu-cli       # CLI tool
└── vayu_tests     # Test suite
```

## Dependencies (via vcpkg)

| Library | Version | Purpose |
|---------|---------|---------|
| curl | 8.11.1 | HTTP client |
| cpp-httplib | 0.18.3 | HTTP server |
| nlohmann-json | 3.11.3 | JSON parsing |
| sqlite3 | 3.47.2 | Database |
| sqlite-orm | 1.9 | ORM |
| gtest | 1.15.2 | Testing |

## VS Code Tasks

- **Build Release** - Release build (default)
- **Build Debug** - Debug build
- **Build and Test** - Build + run tests
- **Run Tests Only** - Run without rebuild
- **Clean Build** - Fresh build from scratch

# Contributing to Vayu

Thank you for your interest in contributing to Vayu! This document provides guidelines and information for contributors.

## Code of Conduct

We are committed to providing a friendly, safe, and welcoming environment. Please be respectful and constructive in all interactions.

## How to Contribute

### Reporting Bugs

1. **Search existing issues** to avoid duplicates
2. **Use the bug report template** (if available)
3. Include:
   - Vayu version (from `app/package.json` or engine version)
   - Operating system and version
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshots/logs if applicable
   - Engine logs (if relevant): `engine/data/logs/` or `~/.config/vayu/logs/`

### Suggesting Features

1. **Search existing issues** for similar suggestions
2. **Use the feature request template** (if available)
3. Describe the use case and benefits
4. Consider implementation complexity
5. Discuss in GitHub Discussions if unsure

### Pull Requests

1. **Fork the repository**
2. **Create a feature branch** from `main`
3. **Make your changes** with clear commits
4. **Add tests** for new functionality (if applicable)
5. **Update documentation** if needed
6. **Submit PR** with a clear description

## Development Setup

### Prerequisites

- **C++ Engine**: CMake 3.25+, C++20 compiler, vcpkg
- **Electron App**: Node.js ≥ 20 LTS, pnpm ≥ 8

### Quick Start

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/vayu.git
cd vayu

# Add upstream remote
git remote add upstream https://github.com/athrvk/vayu.git

# Create feature branch
git checkout -b feature/my-feature

# Build for your platform
# macOS:
./scripts/build/build-macos.sh dev

# Linux:
./scripts/build/build-linux.sh dev

# Windows:
.\scripts\build\build-windows.ps1 dev

# Start the app
cd app && pnpm run electron:dev
```

For detailed platform-specific build instructions, see:
- [Building on macOS](building-macos.md)
- [Building on Linux](building-linux.md)
- [Building on Windows](building-windows.md)

## Project Structure

```
vayu/
├── engine/          # C++ core
│   ├── src/         # Source files
│   ├── include/     # Public headers
│   ├── tests/       # Google Test suite
│   └── vcpkg.json   # Dependencies
├── app/             # Electron + React UI
│   ├── electron/    # Main process
│   ├── src/         # Renderer (React)
│   └── package.json # Dependencies
├── scripts/         # Build scripts
│   ├── build/       # Platform-specific build scripts
│   └── test/        # Test scripts
└── docs/            # Documentation
    ├── engine/      # Engine documentation
    ├── app/         # App documentation
    └── ...          # Other docs
```

## Coding Standards

### C++ (Engine)

- **Standard:** C++20
- **Style:** Google C++ Style Guide (with modifications)
- **Formatting:** clang-format (config in `.clang-format` if present)
- **Linting:** clang-tidy

#### Naming Conventions

```cpp
// Classes: PascalCase
class HttpClient {};

// Functions/Methods: snake_case
void send_request();

// Variables: snake_case
int request_count;

// Constants: kPascalCase
const int kMaxConnections = 1000;

// Namespaces: snake_case
namespace vayu::http {}
```

#### Example Code Style

```cpp
#include "vayu/http/client.hpp"

#include <string>
#include <vector>

namespace vayu::http {

class Client {
public:
    explicit Client(const Config& config);
    ~Client();

    // Disable copy
    Client(const Client&) = delete;
    Client& operator=(const Client&) = delete;

    // Enable move
    Client(Client&&) noexcept = default;
    Client& operator=(Client&&) noexcept = default;

    [[nodiscard]] Response send(const Request& request);

private:
    std::unique_ptr<Impl> impl_;
};

}  // namespace vayu::http
```

### TypeScript/React (App)

- **Style:** ESLint + Prettier (if configured)
- **Framework:** React 19 with hooks
- **State:** Zustand (UI state) + TanStack Query (server state)
- **Styling:** Tailwind CSS

#### Naming Conventions

**File Naming:**
- Components: `PascalCase.tsx` (e.g., `RequestBuilder.tsx`)
- Hooks: `camelCase.ts` with 'use' prefix (e.g., `useEngine.ts`)
- Stores: `kebab-case-store.ts` (e.g., `navigation-store.ts`)
- Services: `kebab-case.ts` (e.g., `http-client.ts`)
- Transformers: `kebab-case-transformer.ts` (e.g., `request-transformer.ts`)
- Queries: `kebab-case.ts` (e.g., `collections.ts`)
- Types: `kebab-case.ts` (e.g., `api.ts`)
- Utils: `kebab-case.ts` (e.g., `helpers.ts`)
- Constants: `kebab-case.ts` (e.g., `error-codes.ts`)
- Error Components: `PascalCase.tsx` (e.g., `ErrorBoundary.tsx`)
- Error Utilities: `kebab-case.ts` (e.g., `error-handler.ts`)

**Code Naming:**
```typescript
// Components: PascalCase
function RequestBuilder() {}

// Hooks: camelCase with 'use' prefix
function useEngine() {}

// Utils/helpers: camelCase
function formatResponse() {}

// Constants: SCREAMING_SNAKE_CASE
const MAX_HISTORY_SIZE = 100;

// Types/Interfaces: PascalCase
interface RequestConfig {}
```

For detailed file naming conventions, see [`app/src/FILE_NAMING_CONVENTIONS.md`](../app/src/FILE_NAMING_CONVENTIONS.md).

#### Formatting and Linting

```bash
cd app
pnpm lint
pnpm type-check
```

## Testing

### Engine (C++)

We use Google Test for C++ unit tests.

```bash
cd engine

# Build and run all tests
./scripts/build/build-and-test.sh

# Run specific test
./build/vayu_tests --gtest_filter=HttpClientTest.*

# Run with verbose output
ctest --test-dir build -V
```

#### Writing Tests

```cpp
#include <gtest/gtest.h>
#include "vayu/http/client.hpp"

namespace vayu::http {
namespace {

TEST(HttpClientTest, SendsGetRequest) {
    Client client;
    Request request{
        .method = "GET",
        .url = "https://httpbin.org/get"
    };

    auto response = client.send(request);

    EXPECT_EQ(response.status, 200);
    EXPECT_FALSE(response.body.empty());
}

}  // namespace
}  // namespace vayu::http
```

### App (TypeScript)

Currently, the app does not have automated tests. If you add tests:

- Use Vitest for unit tests
- Use Playwright for E2E tests (if needed)

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `style` | Formatting (no code change) |
| `refactor` | Code restructure |
| `perf` | Performance improvement |
| `test` | Adding tests |
| `chore` | Maintenance tasks |

### Examples

```
feat(engine): add HTTP/2 support

Implement HTTP/2 protocol using libcurl's HTTP/2 backend.

- Enable multiplexing for concurrent requests
- Add h2 protocol negotiation
- Update connection pooling for h2 streams

Closes #123
```

```
fix(app): resolve memory leak in response viewer

The JSON tree component was not properly unmounting,
causing retained references to large response bodies.
```

## Pull Request Process

### Before Submitting

- [ ] Code follows style guidelines
- [ ] All tests pass locally (if applicable)
- [ ] New tests added for new features (if applicable)
- [ ] Documentation updated
- [ ] Commit messages follow conventions
- [ ] PR description explains changes

### PR Template

```markdown
## Description
Brief description of changes.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
How was this tested?

## Checklist
- [ ] My code follows the style guidelines
- [ ] I have performed a self-review
- [ ] I have added tests (if applicable)
- [ ] I have updated documentation

## Related Issues
Closes #123
```

### Review Process

1. **Automated checks** run (if configured: CI, linting, tests)
2. **Maintainer review** (typically within 48 hours)
3. **Address feedback** with new commits
4. **Squash and merge** once approved (or merge commit, depending on project preference)

## Architecture Decisions

Major changes should be discussed before implementation:

1. **Open an issue** describing the proposal
2. **Tag it** with `discussion` or `rfc` (if labels exist)
3. **Get feedback** from maintainers
4. **Document** the decision if significant

### Decision Record Template

```markdown
# ADR-001: Use QuickJS for Scripting

## Status
Accepted

## Context
We need a JavaScript engine for running Postman-compatible scripts.

## Decision
Use QuickJS instead of V8.

## Consequences
- Smaller binary size (500KB vs 20MB)
- Faster startup (µs vs ms)
- Limited ES2020 support (no ES2021+)
```

## Getting Help

- **GitHub Issues**: Bug reports, feature requests
- **GitHub Discussions**: Ask questions, share ideas (if enabled)
- **Documentation**: Check `docs/` folder for detailed guides

## Recognition

Contributors are recognized in:
- `CONTRIBUTORS.md` file (if present)
- Release notes
- GitHub contributors page

---

Thank you for contributing to Vayu! 🚀

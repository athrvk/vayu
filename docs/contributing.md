# Contributing to Vayu

Thank you for your interest in contributing to Vayu! This document provides guidelines and information for contributors.

---

## Code of Conduct

We are committed to providing a friendly, safe, and welcoming environment. Please be respectful and constructive in all interactions.

---

## How to Contribute

### Reporting Bugs

1. **Search existing issues** to avoid duplicates
2. **Use the bug report template**
3. Include:
   - Vayu version
   - Operating system
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshots/logs if applicable

### Suggesting Features

1. **Search existing issues** for similar suggestions
2. **Use the feature request template**
3. Describe the use case and benefits
4. Consider implementation complexity

### Pull Requests

1. **Fork the repository**
2. **Create a feature branch** from `main`
3. **Make your changes** with clear commits
4. **Add tests** for new functionality
5. **Update documentation** if needed
6. **Submit PR** with a clear description

---

## Development Setup

See [Building from Source](building.md) for detailed instructions.

### Quick Start

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/vayu.git
cd vayu

# Add upstream remote
git remote add upstream https://github.com/vayu/vayu.git

# Create feature branch
git checkout -b feature/my-feature

# Build engine
cd engine && cmake -B build -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build build

# Build app
cd ../app && pnpm install && pnpm dev
```

---

## Project Structure

```
vayu/
├── engine/          # C++ core (most contributions here)
│   ├── src/         # Source files
│   ├── include/     # Public headers
│   └── tests/       # Google Test suite
├── app/             # Electron + React UI
│   ├── electron/    # Main process
│   └── src/         # Renderer (React)
├── shared/          # Shared schemas
├── docs/            # Documentation
└── scripts/         # Build scripts
```

---

## Coding Standards

### C++ (Engine)

- **Standard:** C++20
- **Style:** Google C++ Style Guide (with modifications)
- **Formatting:** clang-format (config in `.clang-format`)
- **Linting:** clang-tidy

```bash
# Format code
clang-format -i src/**/*.cpp include/**/*.hpp

# Run linter
clang-tidy src/**/*.cpp -- -I include
```

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

- **Style:** ESLint + Prettier
- **Framework:** React 18 with hooks
- **State:** Zustand
- **Styling:** Tailwind CSS

```bash
# Format and lint
cd app
pnpm lint
pnpm format
```

#### Naming Conventions

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

---

## Testing

### Engine (C++)

We use Google Test for C++ unit tests.

```bash
cd engine

# Run all tests
ctest --test-dir build --output-on-failure

# Run specific test
./build/tests/http_client_test

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

TEST(HttpClientTest, HandlesTimeout) {
    Client client;
    Request request{
        .method = "GET",
        .url = "https://httpbin.org/delay/10",
        .timeout_ms = 1000
    };

    EXPECT_THROW(client.send(request), TimeoutError);
}

}  // namespace
}  // namespace vayu::http
```

### App (TypeScript)

We use Vitest for unit tests and Playwright for E2E.

```bash
cd app

# Run unit tests
pnpm test

# Run E2E tests
pnpm test:e2e

# Run with coverage
pnpm test:coverage
```

---

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

---

## Pull Request Process

### Before Submitting

- [ ] Code follows style guidelines
- [ ] All tests pass locally
- [ ] New tests added for new features
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
- [ ] I have added tests
- [ ] I have updated documentation

## Related Issues
Closes #123
```

### Review Process

1. **Automated checks** run (CI, linting, tests)
2. **Maintainer review** within 48 hours
3. **Address feedback** with new commits
4. **Squash and merge** once approved

---

## Architecture Decisions

Major changes should be discussed before implementation:

1. **Open an issue** describing the proposal
2. **Tag it** with `discussion` or `rfc`
3. **Get feedback** from maintainers
4. **Document** the decision in `docs/decisions/`

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

---

## Getting Help

- **Discord:** [discord.gg/vayu](https://discord.gg/vayu)
- **GitHub Discussions:** Ask questions, share ideas
- **Issues:** Bug reports, feature requests

---

## Recognition

Contributors are recognized in:
- `CONTRIBUTORS.md` file
- Release notes
- GitHub contributors page

---

Thank you for contributing to Vayu! 🚀

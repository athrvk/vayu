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
|   ├── vendor/      # External dependencies
│   └── vcpkg.json   # Dependencies
├── app/             # Electron + React UI
│   ├── electron/    # Main process
│   ├── src/         # Renderer (React)
|   ├── public/      # Public assets
|   ├── installer/   # Installer files
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

# Build and run all tests (this script only on linux or macOS)
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


## Getting Help

- **GitHub Issues**: Bug reports, feature requests
- **GitHub Discussions**: Ask questions, share ideas (if enabled)
- **Documentation**: Check `docs/` folder for detailed guides


## Releasing

Vayu uses a simple, explicit release process that relies on a top-level `VERSION` file as the single source of truth.

1. Update the `VERSION` file to the desired version (for example `0.1.2`). Use the helper script to do this:

```bash
./scripts/bump-version.sh 0.1.2
```

2. Commit the updated `VERSION` file (some bump scripts may commit automatically — check the script):

```bash
git add VERSION engine/include/vayu/version.hpp engine/CMakeLists.txt engine/vcpkg.json app/package.json
git commit -m "chore(release): 0.1.2"
```

3. Create a Git tag that is prefixed with `v` and matches the `VERSION` file, then push the tag to the remote:

```bash
git tag v$(cat VERSION)
git push origin --tags
```

4. The GitHub Actions workflow will run on the pushed tag, run tests, build the app/engine, and upload installer artifacts to the Release associated with that tag.

Notes:

- The `VERSION` file should be kept accurate. The workflow uses a pushed tag to identify the release and uploads matching artifacts.
- Electron-generated filenames already include the version (for example `Vayu Setup 0.1.2.exe` and `Vayu-0.1.2-x86_64.AppImage`), so the workflow publishes them as-is.
- If you want the bump script to also create the tag and push, you may extend it, but this project requires an explicit tag push so releases remain deliberate.


### Tag and release policy

Because this repository is public, anyone can push tags (if they have push access). To keep releases secure and reliable we recommend the following:

- Protect the `master` branch and restrict who can push to it (Repository Settings → Branches → Add rule for `master` → Restrict who can push). This ensures only trusted maintainers can merge to master.
- Require pull request reviews and CI success before merging to `master` (enable branch protection checks). That reduces risk of accidental or malicious commits being tagged.
- Consider enforcing repository-level controls (branch protection and restricted push access) to limit who can create tags/releases.
- Limit who can create releases / tags: use a small team of maintainers with write access. Alternatively, use a CI bot (with a deploy key or PAT stored in repository secrets) to create signed releases on behalf of maintainers.

Practical workflows

- Maintainer-driven: maintainers merge PRs into `master`, then run the bump script, create the `vX.Y.Z` tag, and push it. The workflow validates the tag and publishes artifacts.
- Automated: run the bump-and-release script from a protected CI job (requires a token with permission to push tags). This centralizes tag creation and avoids relying on individual developers' pushes.

Note: to avoid accidental or malicious releases, restrict who can push to `master` and who can create tags in repository settings; alternatively use a CI bot to create releases on behalf of maintainers.

## Getting Help

- **GitHub Issues**: Bug reports, feature requests
- **Documentation**: Check `docs/` for detailed guides

---

Thank you for contributing to Vayu! 🚀

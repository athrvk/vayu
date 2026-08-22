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

# Build (all platforms use the same command)
python build.py --dev

# Start the app
cd app && pnpm run electron:dev
```

For detailed build instructions and troubleshooting, see [Building Guide](docs/building.md).

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
- **Formatting:** clang-format, **19 exactly**. `.clang-format` at the repository
  root governs `engine/{src,include,tests}`; `engine/vendor/` is excluded by a
  `DisableFormat: true` config of its own. The major is pinned because 39 of the
  285 engine sources format differently under 18 than under 19 - Ubuntu 24.04
  ships 18 by default, so `apt install clang-format-19`, which is also the major
  the clang-tidy gate uses. Check the way CI does, or fix in place:

  ```bash
  clang-format-19 --style=file --dry-run -Werror \
    $(git ls-files -- engine/src engine/include engine/tests | grep -E '\.(c|cpp|h|hpp)$')

  clang-format-19 --style=file -i <file>...
  ```

  The `scripts/pre-commit` hook runs the same check over the engine sources you
  stage and refuses the commit on a difference, so the gate is reachable before
  the push (#908). It looks for `clang-format-19` first and a plain
  `clang-format` second, and skips - loudly, checking nothing - when neither is
  a 19, because a check by another major is a wrong answer rather than a missing
  one.

  The `Engine formatting` job checks the **whole tree**, not just your changed
  lines - the tree is clean, so there is no pre-existing noise to grandfather.
  The bulk-format commit that made it clean is in `.git-blame-ignore-revs`; run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once per clone and
  `git blame` keeps attributing lines to whoever wrote them.
- **Linting:** clang-tidy, **19 or newer**. `engine/.clang-tidy` uses
  `ExcludeHeaderFilterRegex`, which landed in LLVM 19; an older binary rejects
  the config file outright and lints nothing. The `scripts/pre-commit` hook
  probes the version and says so rather than passing silently - if you see that
  warning, install a newer clang-tidy (Ubuntu 24.04 ships 18 by default;
  `apt install clang-tidy-19` is what CI uses) or lean on CI, which lints the
  engine sources your pull request changes on clang-tidy 19.

  The hook finds what that install gives you: like the formatter above, it looks
  for `clang-tidy-19` first and a plain `clang-tidy` second, because apt leaves
  the plain name at the distribution's 18 while Homebrew's LLVM and the Windows
  installer use it (#918). Both tools share one lookup, so the two cannot drift
  apart again.

  A finding fails in both places - the hook refuses the commit, CI fails the
  engine job - and both gate the **lines** you changed, not the whole file, so
  a finding older than your diff stops neither (#902). A hook refusal is
  therefore a merge blocker you are seeing early. To lint whole staged files
  instead, backlog and all, commit once with `VAYU_TIDY_FULL=1`. See
  [Static Analysis](docs/engine/building.md#static-analysis).

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

- **Style:** ESLint + Prettier, both **enforced by CI** - the app job fails on a
  lint error, a warning, or an unformatted file
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
- Constants: `kebab-case.ts` (e.g., `storage-keys.ts`)
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
pnpm lint          # ESLint, zero errors *and* zero warnings
pnpm format:check  # Prettier
pnpm type-check
```

The PR workflow runs all three on its `App quality checks` job - one Linux
runner, in parallel with the test jobs - so a new `any`, a `react-hooks`
violation, an unformatted file or a type error fails CI. Where a rule genuinely
cannot be satisfied, suppress it on the single line with a comment saying why -
an unexplained `eslint-disable` is treated as a defect.

### Shell and Python (tooling)

The installer, the git hook, the test harnesses and `build.py` are the
repository's third language pair, and CI lints both on its `Script lint` job:

```bash
shellcheck $(git ls-files '*.sh' 'scripts/pre-commit' | grep -v '^engine/vendor/')
ruff check $(git ls-files '*.py')
```

Two things are worth knowing before you run those locally:

- **The versions are pinned** - shellcheck **v0.10.0** and ruff **0.15.8**, the
  same builds the job installs. Both tools change their findings between
  releases (shellcheck has twice failed here on a rule the other distribution's
  build does not emit, once under a renumbered code), so an unpinned local run
  can disagree with CI in either direction.
- **The file lists come from `git ls-files`**, not from a list in the workflow.
  A script added anywhere in the tree is linted the day it lands, without an
  edit to CI - which is the point: the enumerated list this replaced had drifted
  to five of the twelve tracked shell scripts.

ruff runs on its **default** rules. A finding is a fix, not a suppression,
unless the code cannot be written another way. Bare `except:` in particular is
a defect rather than a style question here: it swallows `KeyboardInterrupt`, so
a Ctrl-C during one of `build.py`'s slow toolchain probes is eaten instead of
aborting the build. Catch what the call can actually raise - for a subprocess
probe that is `(OSError, subprocess.SubprocessError)`.

## Testing

### Engine (C++)

We use Google Test for C++ unit tests.

```bash
# Build and run all tests (all platforms)
python build.py -e -t

# Run tests only (without rebuilding)
python build.py --test-only

# Run specific test directly
./engine/build/vayu_tests --gtest_filter=HttpClientTest.*

# Run with verbose output
ctest --test-dir engine/build -V
```

#### Writing Tests

A new `engine/tests/*_test.cpp` must be added to the `add_executable(vayu_tests ...)`
source list in `engine/CMakeLists.txt`. The list is explicit, not a glob, so an
unregistered file is simply never compiled and its tests never run - which is
silent, because a file that is not built produces no output. A configure-time
guard fails the build naming any test file missing from the list, so you find
out on your next build rather than never.

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

## Documentation

Everything in `docs/` is published to **[athrvk.github.io/vayu](https://athrvk.github.io/vayu/)**
by `.github/workflows/docs.yml` on every push to `master` that touches the docs.
The site is built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/)
from `.github/mkdocs.yml`.

```bash
pip install -r requirements-docs.txt
mkdocs serve -f .github/mkdocs.yml            # live preview
mkdocs build --strict -f .github/mkdocs.yml   # exactly what CI runs
```

`-f` is not optional: the config lives in `.github/`, so bare `mkdocs serve`
exits with "Config file 'mkdocs.yml' does not exist." The preview URL is
`http://127.0.0.1:8000/vayu/` - the `/vayu/` prefix is there because the site is
a project page served from a subdirectory, and `/` redirects to it.

Site-only styling lives in `docs/stylesheets/extra.css` (accent, header, headings,
landing page). It styles the documentation site, **not** the product - the token
rules in [Design System](docs/design-system.md) do not apply to it, and it must
never be used as a reference for app CSS.

The site's favicon and header logo are **not** files under `docs/`.
`.github/hooks/brand_assets.py` pulls `shared/icon_png/vayu_icon_256x256.png` into the
build, so the docs share one icon with the installers and cannot drift from
them. Do not add a copy under `docs/images/` - if the brand icon is regenerated,
the site picks it up on the next build. A missing source file fails the build
rather than publishing a broken favicon.

Two rules when you add or change a doc:

- **Add the page to the `nav:` in `.github/mkdocs.yml`.** A file that is not in the nav
  still builds and is still reachable by URL, but it never appears in the
  sidebar, so in practice nobody finds it.
- **Keep cross-links relative and anchors real.** `mkdocs build --strict` fails
  on a relative `.md` link that does not resolve and on a `#heading-anchor` that
  does not exist, and the pull-request run does the same. Anchors follow GitHub's
  slug rules (configured in `.github/mkdocs.yml`), so a link that works in GitHub's
  markdown view works on the site, and vice versa. Note that a heading such as
  `## Shared Auth Fields (components/shared/AuthFields/)` slugifies to
  `#shared-auth-fields-componentssharedauthfields` - the parenthetical is part of
  the anchor.

Links out of `docs/` (to `SECURITY.md`, `LICENSE`, `CONTRIBUTING.md`) must be
absolute `https://github.com/athrvk/vayu/blob/master/...` URLs: those files are
outside the published tree, so a relative path 404s on the site.

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
| `ci` | CI workflows and automation |
| `build` | Build scripts, tooling, dependencies |

These are the types `.github/workflows/pr-title.yml` accepts. A pull request
title outside the list fails that check, so add a row here first if you need a
new one.

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

1. Bump the version using the build script:

```bash
# Bump patch version (0.1.1 -> 0.1.2)
python build.py --bump-version patch

# Or bump minor/major
python build.py --bump-version minor   # 0.1.1 -> 0.2.0
python build.py --bump-version major   # 0.1.1 -> 1.0.0

# Or set specific version
python build.py --bump-version 0.1.2

# Preview changes first
python build.py --bump-version patch --dry-run
```

This updates: `VERSION`, `engine/CMakeLists.txt`, `engine/include/vayu/version.hpp`, `app/package.json`

`engine/vcpkg.json` is deliberately **not** in that list and must not carry a
`version` field. It is optional for a top-level manifest, nothing reads it, and
vcpkg leaves it out of the ABI hash that names cached binary packages - but CI
keys its vcpkg cache on `hashFiles('engine/vcpkg.json')`, so bumping it minted a
fresh cache key on every release and made each one rebuild curl, OpenSSL and
libsodium from source. `build.py` refuses to bump if the field reappears.

2. Commit the version bump:

```bash
git add VERSION engine/include/vayu/version.hpp engine/CMakeLists.txt app/package.json
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

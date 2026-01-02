# Vayu Development Plan

**Version:** 1.0  
**Target:** macOS (Apple Silicon & Intel) → Windows → Linux  
**Repository:** Single monorepo with GitHub Releases

---

## 1. Project Structure

```
vayu/
├── .github/
│   └── workflows/
│       ├── ci.yml                 # Build & test on PR/push
│       └── release.yml            # Build artifacts on tag push
│
├── engine/                        # C++ Core Engine
│   ├── CMakeLists.txt
│   ├── vcpkg.json                 # C++ dependency manifest
│   ├── src/
│   │   ├── main.cpp               # CLI entrypoint (vayu-cli)
│   │   ├── daemon.cpp             # Daemon entrypoint (vayu-engine)
│   │   ├── http/
│   │   │   ├── client.cpp         # libcurl wrapper
│   │   │   └── server.cpp         # cpp-httplib Control API
│   │   ├── runtime/
│   │   │   ├── script_engine.cpp  # QuickJS integration
│   │   │   └── context_pool.cpp   # JS context pooling
│   │   ├── core/
│   │   │   ├── thread_pool.cpp    # Worker thread management
│   │   │   ├── event_loop.cpp     # curl_multi event loop
│   │   │   └── stats.cpp          # Thread-local statistics
│   │   └── utils/
│   │       ├── json.cpp           # nlohmann/json helpers
│   │       └── variable_sub.cpp   # {{variable}} substitution
│   ├── include/
│   │   └── vayu/                  # Public headers
│   └── tests/
│       └── ...                    # Google Test suite
│
├── app/                           # Electron + React UI
│   ├── package.json
│   ├── electron/
│   │   ├── main.ts                # Electron main process
│   │   ├── preload.ts             # Context bridge
│   │   └── sidecar.ts             # Engine process manager
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── RequestBuilder/    # Method, URL, Headers, Body
│   │   │   ├── ResponseViewer/    # Pretty JSON, Headers
│   │   │   ├── Dashboard/         # Real-time stats (RPS, latency)
│   │   │   └── Sidebar/           # Collections, Environments
│   │   ├── hooks/
│   │   │   └── useEngine.ts       # SSE connection to engine
│   │   └── stores/
│   │       └── requestStore.ts    # Zustand state management
│   ├── public/
│   └── electron-builder.yml       # Packaging config
│
├── shared/                        # Shared schemas/types
│   ├── request.schema.json        # Request format spec
│   └── types/
│       └── index.d.ts             # TypeScript definitions
│
├── scripts/
│   ├── build-engine.sh            # Build C++ engine
│   ├── build-app.sh               # Build Electron app
│   └── package-release.sh         # Create distributable
│
├── docs/
│   ├── architecture.md
│   ├── api-reference.md           # Control API docs
│   └── postman-migration.md
│
├── Vayu.md                        # Original design doc
├── PLAN.md                        # This file
├── README.md
├── LICENSE
└── .gitignore
```

---

## 2. Build Tools & Dependencies

### Engine (C++)

| Tool | Version | Purpose |
|------|---------|---------|
| **CMake** | ≥3.25 | Build system generator |
| **vcpkg** | latest | C++ package manager |
| **Clang/LLVM** | ≥15 | Compiler (macOS default) |
| **Ninja** | ≥1.11 | Fast build executor |

**C++ Dependencies (via vcpkg):**

```json
{
  "dependencies": [
    "curl",
    "nlohmann-json",
    "cpp-httplib",
    "gtest"
  ]
}
```

**QuickJS:** Vendored in `engine/vendor/quickjs/` (no vcpkg package)

**Build Commands:**
```bash
# Configure
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake

# Build
cmake --build build --target vayu-cli vayu-engine

# Test
ctest --test-dir build --output-on-failure
```

### App (Electron/React)

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | ≥20 LTS | Runtime |
| **pnpm** | ≥8 | Package manager (fast, disk efficient) |
| **Vite** | ≥5 | Frontend bundler |
| **electron-builder** | ≥24 | App packaging |

**Key Dependencies:**
```json
{
  "dependencies": {
    "react": "^18.x",
    "zustand": "^4.x",
    "tailwindcss": "^3.x",
    "@tanstack/react-query": "^5.x"
  },
  "devDependencies": {
    "electron": "^28.x",
    "electron-builder": "^24.x",
    "vite": "^5.x",
    "typescript": "^5.x"
  }
}
```

---

## 3. Distribution Strategy

### Packaging Architecture

```
┌─────────────────────────────────────────────┐
│            Vayu.app (macOS Bundle)          │
├─────────────────────────────────────────────┤
│  Contents/                                  │
│  ├── MacOS/                                 │
│  │   └── Vayu          (Electron main)      │
│  ├── Resources/                             │
│  │   ├── app.asar      (React bundle)       │
│  │   └── bin/                               │
│  │       └── vayu-engine (C++ binary)       │
│  └── Info.plist                             │
└─────────────────────────────────────────────┘
```

### Release Artifacts

| Platform | Format | Architecture |
|----------|--------|--------------|
| **macOS** | `.dmg`, `.zip` | Universal (arm64 + x86_64) |
| Windows | `.exe` (NSIS), `.zip` | x64 |
| Linux | `.AppImage`, `.deb` | x64 |

### GitHub Release Flow

1. **Tag Push** triggers `release.yml` workflow
2. **Build Matrix** compiles engine + app for each platform
3. **Artifacts** uploaded to GitHub Release
4. **Auto-update** via `electron-updater` (checks GitHub Releases API)

```yaml
# .github/workflows/release.yml
on:
  push:
    tags: ['v*']

jobs:
  build-macos:
    runs-on: macos-14  # Apple Silicon runner
    steps:
      - uses: actions/checkout@v4
      - name: Build Engine (Universal)
        run: ./scripts/build-engine.sh --universal
      - name: Build App
        run: |
          cd app && pnpm install && pnpm build
          pnpm exec electron-builder --mac --universal
      - uses: softprops/action-gh-release@v1
        with:
          files: app/dist/*.dmg
```

### Code Signing (macOS)

- **Developer ID Application** certificate for distribution outside App Store
- **Notarization** via `xcrun notarytool` in CI
- Credentials stored as GitHub Secrets:
  - `APPLE_ID`
  - `APPLE_TEAM_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `CSC_LINK` (base64 .p12 certificate)
  - `CSC_KEY_PASSWORD`

---

## 4. Implementation Milestones

### Phase 1: Engine Prototype ✦ Weeks 1-3

| Task | Deliverable | Status |
|------|-------------|--------|
| CMake + vcpkg setup | Compiling skeleton | ⬜ |
| libcurl GET request | `client.cpp` | ⬜ |
| QuickJS integration | `script_engine.cpp` | ⬜ |
| Expose `pm` object to JS | C++ bindings | ⬜ |
| CLI runner | `./vayu-cli run req.json` | ⬜ |

**Exit Criteria:** Execute a request JSON and run `pm.test()` assertions.

### Phase 2: Core Engine ✦ Weeks 4-7

| Task | Deliverable | Status |
|------|-------------|--------|
| Thread pool | `thread_pool.cpp` | ⬜ |
| `curl_multi` event loop | `event_loop.cpp` | ⬜ |
| Context pooling | `context_pool.cpp` | ⬜ |
| Control API server | `POST /run`, `GET /stats` | ⬜ |
| SSE streaming | Real-time stats | ⬜ |
| Thread-local stats | Lock-free counters | ⬜ |

**Exit Criteria:** Sustain 10k+ RPS on localhost, expose stats via SSE.

### Phase 3: Electron App ✦ Weeks 8-11

| Task | Deliverable | Status |
|------|-------------|--------|
| Scaffold Electron + Vite | `app/` structure | ⬜ |
| Sidecar manager | Spawn/kill engine | ⬜ |
| Request Builder UI | Forms + validation | ⬜ |
| Response Viewer | JSON pretty-print | ⬜ |
| Dashboard | Live charts | ⬜ |
| Collections sidebar | File management | ⬜ |

**Exit Criteria:** Functional app that sends requests via engine.

### Phase 4: Polish & Release ✦ Weeks 12-14

| Task | Deliverable | Status |
|------|-------------|--------|
| Postman import | Collection converter | ⬜ |
| `{{variable}}` substitution | Environment support | ⬜ |
| macOS packaging | `.dmg` with notarization | ⬜ |
| GitHub Actions CI/CD | Automated releases | ⬜ |
| Documentation | README, guides | ⬜ |

**Exit Criteria:** v0.1.0 published to GitHub Releases.

---

## 5. First Steps (Getting Started)

```bash
# 1. Initialize engine project
mkdir -p engine/src engine/include/vayu engine/tests
touch engine/CMakeLists.txt engine/vcpkg.json

# 2. Setup vcpkg (if not installed)
git clone https://github.com/microsoft/vcpkg.git ~/.vcpkg
~/.vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT=~/.vcpkg

# 3. Initialize app project
mkdir -p app
cd app && pnpm create vite . --template react-ts
pnpm add -D electron electron-builder

# 4. Create shared schemas
mkdir -p shared/types
```

---

## 6. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| QuickJS performance bottleneck | Pre-warm context pool; benchmark early |
| curl_multi complexity | Start with curl_easy, refactor in Phase 2 |
| Universal binary size (~150MB) | Offer separate arch downloads |
| Code signing cost ($99/year) | Required for macOS distribution |
| Electron memory overhead | Monitor; consider Tauri for v2 |

---

## 7. Success Metrics

- **Performance:** ≥50k RPS on M1 Mac (localhost echo server)
- **Latency:** p99 < 5ms for single request (Design Mode)
- **Compatibility:** Import 95%+ of Postman Collections

---

*Last Updated: January 2, 2026*

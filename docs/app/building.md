---
description: >-
  Build the Vayu desktop app from source - prerequisites, pnpm scripts, the Vite and Electron pipeline, and packaging.
---

# Building Vayu App

This document outlines how to build the Vayu Manager Electron application from source.

## Prerequisites

- **Node.js**: Version ≥ 22 LTS (`concurrently` 10, which `pnpm type-check`
  runs, declares `node >= 22`; the 20 line is end-of-life)
- **pnpm**: Version ≥ 8 (package manager)
- **Vayu Engine**: Must be built first (see `docs/engine/building.md`)

## Quick Start

### Development Build

```bash
# Install dependencies
pnpm install

# Start development server (browser only)
pnpm dev

# Start Electron app with hot reload
pnpm electron:dev
```

The `electron:dev` command will:
1. Kill any processes on ports 5173 and 9876
2. Start Vite dev server on port 5173
3. Watch and compile Electron main process code
4. Wait for dev server, then start Electron

### Production Build

```bash
# Build React app and Electron
pnpm electron:build

# Or build separately:
pnpm build              # Build React app only
pnpm electron:compile  # Compile Electron main process only
pnpm electron:pack      # Package Electron app (requires build first)
```

## Project Structure

```
app/
├── src/                 # React application source
│   ├── components/     # React components
│   ├── stores/         # Zustand stores
│   ├── queries/        # TanStack Query hooks
│   ├── services/       # API clients
│   └── types/          # TypeScript types
├── electron/           # Electron main process
│   ├── main.ts         # Main process entry
│   ├── preload.ts      # Preload script
│   └── sidecar.ts      # Engine sidecar manager
├── build/              # Build resources (icons, etc.)
├── dist/               # Built React app (production)
├── dist-electron/      # Compiled Electron code
├── release/            # Packaged Electron apps
├── package.json        # Dependencies and scripts
├── vite.config.ts      # Vite configuration
├── tsconfig.json       # TypeScript config (React)
├── tsconfig.node.json  # TypeScript config (Electron main process)
└── tsconfig.electron-test.json  # Type-check config (Electron tests)
```

## Build Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start Vite dev server (browser only) |
| `pnpm build` | Build React app for production |
| `pnpm preview` | Preview production build |
| `pnpm electron:dev` | Start Electron with hot reload |
| `pnpm electron:compile` | Compile Electron main process |
| `pnpm electron:watch` | Watch Electron code for changes |
| `pnpm electron:build` | Full production build (compile + build + package) |
| `pnpm electron:pack` | Package Electron app (requires build first) |
| `pnpm type-check` | TypeScript type checking (renderer, main process, and the Electron tests - the three projects run concurrently, and a failure in any of them fails the script) |
| `pnpm lint` | Run ESLint |

## Development Workflow

### Running in Development

1. **Start the engine** (if not auto-started):
   ```bash
   cd engine
   ./build/vayu-engine --port 9876
   ```

2. **Start the app**:
   ```bash
   cd app
   pnpm electron:dev
   ```

The app will:
- Connect to Vite dev server on `http://localhost:5173`
- Auto-start the engine if binary is found
- Hot reload on code changes

### Debugging

**Renderer Process (React):**
- Open DevTools: `mainWindow.webContents.openDevTools()` in `main.ts`
- Or use React DevTools extension
- `console.log()` is a lint error under `app/src` (`no-console`, `warn` and
  `error` allowed): it is for reading while you work, not for committing, and
  the calls that accumulated this way were dumping stored requests with their
  auth headers into DevTools. Delete the call before you commit, or keep it as
  a `console.warn` if the state it reports is genuinely abnormal.

**Main Process (Electron):**
- Use VS Code debugger with launch configuration
- Or use `console.log()` (outputs to terminal) - the rule above is renderer-only,
  because the main process console is the log the user actually reads

**Engine:**
- Engine logs appear in Electron main process console
- Check `engine/data/` for database and log files

## Production Build

### Build Steps

1. **Build the engine** (see `docs/engine/building.md`):
   ```bash
   python build.py -e
   ```

2. **Copy engine binary** to `app/build/resources/bin/`:
   ```bash
   # macOS/Linux
   cp engine/build/vayu-engine app/build/resources/bin/
   
   # Windows
   cp engine/build/Release/vayu-engine.exe app/build/resources/bin/
   ```

3. **Build the app**:
   ```bash
   cd app
   pnpm electron:build
   ```

### Build Outputs

Production builds are output to `app/release/`. `artifactName` in
`electron-builder.json` is the source of truth for these names: the top-level
pattern is `${productName}-${arch}.${ext}`, and the `mac` and `appImage` blocks
override it to insert `${version}`, so the dmg, the zip and the AppImage carry
a version while the exe and the deb do not.

- **macOS**: `Vayu-<version>-universal.dmg` and `Vayu-<version>-universal.zip`.
  The zip carries the macOS install and update path - `install.sh` downloads it
  and `latest-mac.yml` names it - while the dmg is the drag-to-Applications
  route. A single-arch build names that arch instead of `universal`, which is
  what `python build.py` does on macOS.
- **Windows**: `Vayu-<arch>.exe` (NSIS installer)
- **Linux**: `Vayu-<version>-x86_64.AppImage` and `Vayu-amd64.deb`

### Electron Builder Configuration

Configuration is in `electron-builder.json`:

- **macOS**: DMG with universal binary, code signing (if configured)
- **Windows**: NSIS installer with custom installer script
- **Linux**: AppImage and Debian package

**Key Settings:**
- App ID: `io.github.athrvk.vayu`
- Product Name: `Vayu`
- Engine binary: Packaged in `resources/bin/` (copied to `bin/` in app)

#### The app id, and the two things pinned to it

The id is reverse-DNS of a domain the project holds. It was `com.vayu.client`,
which claimed `vayu.com` - a domain it does not own - and named the app after
the npm package rather than the product. It is the macOS `CFBundleIdentifier`,
so it also names where macOS keeps preferences, caches and saved state, and it
is the AppUserModelID Windows files the app's notifications under
(`APP_USER_MODEL_ID` in `electron/constants.ts`, compared to `appId` by
`app-user-model-id.test.ts`).

Two settings exist because the id changed rather than because anyone wanted
them:

- `nsis.guid` is pinned to `c6b9dc37-95fd-5c7e-9133-446b81eb3ee5`, the value
  electron-builder derived from the **old** id. NSIS keys the uninstall entry
  and the upgrade path off that GUID, so without the pin every existing Windows
  install would see the next version as a different application and end up
  listed twice in Add/Remove Programs. It is not a value to regenerate: it is
  the identity those installs already carry.
- `install.sh` purges the old identifier's `Preferences`, `Caches` and
  `Saved Application State` alongside the current one, because macOS wrote them
  under the id the app ran under at the time, and nothing else would ever
  remove them.

## TypeScript Configuration

### One compiler runs, two are installed

Every script that compiles runs the **native TypeScript 7** compiler:
`pnpm type-check` checks the three projects with it, and `pnpm build`,
`pnpm electron:compile` and `pnpm electron:watch` emit with it. It is worth
roughly 6x on the gate (31.8s → 4.9s on a cloud runner).

The emit moved to 7 only after the two compilers were shown to produce the same
main process: `tsconfig.node.json` built with each in turn differs in **one
line of one `.d.ts`**, where 7 quotes a string containing `"` with single
quotes instead of escaping it. All 47 emitted `.js` files are byte-identical.
Re-run that comparison rather than trusting this sentence if the pinned 7.x
moves.

`typescript` 5.9 stays installed even though nothing invokes it as a compiler
any more (#467 Stage 1). Two things still read it by package name:
`typescript-eslint`, whose peer range is `>=4.8.4 <6.1.0`, so a single
`typescript@7` would break `pnpm lint`, which CI enforces at zero warnings; and
`src/hooks/script-typedefs.docs-compile.test.ts`, which drives the Compiler API
(`ts.createProgram`) to type-check the `pm.*` documentation examples. Stage 2 -
one `typescript@7`, alias gone - waits for 7.1, the release that gives
typescript-eslint the stable API.

TypeScript 7 is installed under the alias `tsc7` (`tsc7: npm:typescript@^7`), so
both packages are present. **Both claim the `tsc` bin, and only one wins
`node_modules/.bin/tsc`** - so no script may invoke a bare `tsc`. Each names its
compiler by path (`node node_modules/tsc7/bin/tsc`), because the alternative is
letting a package manager's bin-conflict resolution decide which compiler emits
the code that ships. `src/typescript-toolchain.test.ts` fails on a bare `tsc` in
any script.

Both compilers are still held to identical diagnostics on all three projects -
see `strict` under the main-process config below for the one place they
diverged, which is also why every config states it out loud.

### React App (`tsconfig.json`)

- Target: ES2020
- Lib: `ES2020`, `ES2022.Error`, `DOM`, `DOM.Iterable`
- Module: ESNext
- JSX: React
- Path aliases: `@/*` → `./src/*`
- `types: ["node"]`

`ES2022.Error` is one sliver of a later standard library, not a target move: it
declares `ErrorOptions`, which is what types `new Error(message, { cause })`.
The runtime has had `cause` since Chromium 93 and Node 16, and `updater.ts`
already reads it off a caught error, so the entry describes what the app runs
on rather than changing it. ESLint's `preserve-caught-error` is what made the
gap load-bearing: it asks that an error thrown from a `catch` carry the caught
one as its cause, and without the type that fix does not compile. All three
configs carry the same entry.

The last two are written the way they are because TypeScript 7 removes `baseUrl`
and changes the default of `types` from "every package under `node_modules/@types`"
to `[]`. Both are spelled out here so the config means the same thing to 5.x and
7.x: alias targets are relative (a non-relative target without `baseUrl` is the
hard error TS5090), and the one ambient type package the source-scanning tests
rely on is named. Adding an `@types/*` package that provides globals means adding
it to that list.

The alias table is duplicated by hand in `vite.config.ts` and `vitest.config.ts`;
neither reads this file, so a new alias has to be added in all three.

### Electron main process (`tsconfig.node.json`)

- Target: ES2020
- Lib: stated rather than inherited, and identical to the renderer's - `ES2020`
  alone would leave out `ErrorOptions` (see the renderer config above). Stating
  it drops three entries `target: ES2020` used to imply through
  `lib.es2020.full`: `ScriptHost` and `WebWorker.ImportScripts`, which describe
  environments the main process is not, and `DOM.AsyncIterable`, which types
  `for await` over a DOM stream - `electron/` does none of the three, and
  neither sibling config admits them either
- Module: ESNext (the app is `"type": "module"`)
- Includes `electron/`, emitting to `dist-electron/`
- Excludes `electron/**/*.test.ts` - tests are not part of the main process, and
  emitting them put vitest imports in the shipped bundle
- `strict: true`, stated rather than inherited

`strict` is spelled out for the same reason `types` is in the renderer config,
and it is the one thing a full two-compiler diff of this tree turned up.
TypeScript 5 defaults it to `false` and TypeScript 7 defaults it to `true`, and
this config had never set it - so the entire main process was checked
non-strictly by the build and strictly by the gate. Exactly one error separated
the two (a `string | undefined` that neither compiler's control flow can prove
is set, in the MCP `spec_info` handler), which is why the answer was to state
`true` and fix the one site rather than pin the laxer default: `app/CLAUDE.md`
already gives strict TypeScript as the convention, the renderer already sets it,
and `electron/` was written as though it held - its `!` assertions on
guard-proved values are no-ops without it.

`tsconfig.electron-test.json` inherits the value through `extends`.
`src/typescript-toolchain.test.ts` fails on any of the three configs whose
`extends` chain never states `strict`.

### Electron tests (`tsconfig.electron-test.json`)

- `noEmit` - it exists to type-check what `tsconfig.node.json` excludes
- Lib: the same four entries as the other two configs, stated here rather than
  inherited - a test that reaches into `app/src/` is DOM code, and this config
  said so back when the main-process one left its list implicit
- Adds the `@/*` → `./src/*` alias, which the main-process config deliberately
  lacks: only a test may cross into `app/src/` (`resolve.test.ts` compares the
  renderer's dynamic-variable table against the main-process copy)
- Run by `pnpm type-check`; without it nothing checked these files, and a
  missing module in `resolve.test.ts` passed CI while breaking
  `python build.py --dev`

## Measuring what a build costs

`.github/workflows/perf-measure.yml` records the built renderer's entry-chunk
size, its total `dist/` size, and two startup figures - per platform, weekly
and on demand. It is a measurement, not a gate: nothing there fails a build on
a number.

`scripts/perf/measure-app.mjs` is what produces those figures and runs locally
the same way, against an existing `pnpm run build` (and, for the packaged
figure below, an unpacked `electron-builder` output):

```bash
node scripts/perf/measure-app.mjs --out perf-app.json --packaged-dir app/release   # from the repo root
```

`--packaged-dir` is optional - without it the packaged leg reports
`"unavailable"` and the renderer-graph figures still come out.

**On a headless Linux box the packaged figure is unreliable, and the CI runner
is one.** Under `xvfb-run` the app produced a figure once across the runs that
landed this leg and timed out every other time, each time having come up whole
- engine listening, MCP up, the renderer fetching config, collections and
globals from it, inside a second - and then produced no frame, so
`ready-to-show` never fired and the leg reported `"unavailable"` with that
output in `note`. The harness's plain window becomes
showable in the same session every time, and the app's window is frameless.
Running a window manager in the session changed nothing. #1347 tracks it; the
Windows and macOS figures are unaffected, as is a Linux desktop, where this has
not been seen.

**The packaged figure is the real cold start.** The workflow builds the
renderer, compiles the Electron main process, stages the engine binary into
`app/build/resources/bin/` (where `sidecar.ts` looks inside a package), and
packages an unpacked build - `electron-builder --linux dir`, and the
`--win dir` / `--mac dir` equivalents; `--dir`, no installer, and no
architecture named, so each runner packages for its own.
`measure-app.mjs` launches that executable three times with
`VAYU_MEASURE_STARTUP=1` set and reports the median milliseconds from process
start to `ready-to-show`: the executable's own load, the main process's import
graph, the window it creates and the renderer inside it, with the sidecar
spawn running alongside. It does not include the engine handshake, and should
not - #1144 deliberately put the window ahead of that, and this number is what
a user waits for. Between launches it waits for the
engine to stop listening on port 9876, because `sidecar.ts` adopts an engine
that is already running rather than starting a fresh one, and an adopted
engine is not a cold start; a launch that fails, or an engine that will not go
away in time, is reported `"unavailable"` with the reason in `note` rather
than retried.

The first of the three launches is a first run - it creates the user-data
directory the other two find waiting, and measured several times the others on
a cloud container (5.6 s against 1.2 s). The median is what is reported, so
that launch informs the number without setting it; read `launches` in the JSON
before drawing anything from a single figure.

`VAYU_MEASURE_STARTUP=1` is what makes the app print that line at all
(`app/electron/startup-probe.ts`). Unset - which is every real launch - it
measures and prints nothing.

What the packaged leg still does not measure: the installer formats
themselves (NSIS, the dmg, AppImage's FUSE mount), because the workflow
packages `--dir`. An unpacked build is the same asar, the same staged engine
and the same main process a user installs; only the installer wrapper is
absent.

**The renderer-graph figure stays beside it, unchanged.** It comes from
`scripts/perf/startup-harness.cjs`, a small Electron main script that loads
`app/dist/index.html` into a window of its own - not the Vayu app - and times
it against a blank window. The delta isolates the cost of the renderer's
module graph and its render-blocking fetches from everything the main
process does, which the packaged figure cannot separate back out; it is the
number #1146/#1147's bundle work moves and the one this program's history is
recorded in. That file's header states the boundary in full; read it before
quoting the number.

## Vite Configuration

Key settings in `vite.config.ts`:

- **Base**: `./` (relative paths for Electron)
- **Port**: 5173 (dev server)
- **Aliases**: Path shortcuts (`@/components`, `@/stores`, etc.)
- **Code Splitting**: no manual chunk groups, deliberately (#1147). What defers
  a chunk here is a dynamic import - `React.lazy` on the tab surfaces,
  `ensureMonaco()` on the editor - and rolldown's own chunking does the rest.
  The `react-vendor` and `charts` groups that used to sit here were measured
  against it and moved nothing: same 132 chunks, same 14.9MB total, the same
  modules behind the same lazy boundaries. A packaged app loads from asar, so
  there is no cross-release HTTP cache for a vendor chunk to hit either. Adding
  a group for monaco was worse than inert - the named group turned the 3.7MB
  editor chunk into a `modulepreload` in `dist/index.html`, back onto the
  startup path #1146 had taken it off. Read `dist/index.html`'s preload list,
  not just chunk sizes, before adding a group here
- **Monaco's entry is composed, not the package root** (`src/lib/monaco-setup.ts`):
  the editor core, the two language services the app drives, and one Monarch
  grammar per language id it can open - rather than the package root's ~85
  grammars and four language services. The CSS and HTML language services
  reach their workers through `new Worker(new URL(…))` in monaco's own
  `workerManager`, so importing the root shipped `css.worker` (1.0MB) and
  `html.worker` (0.7MB) in every installer that nothing could reach. Composing
  the entry took `dist/` from 17.2MB to 14.9MB with startup unchanged: those
  two workers are 1.8MB of the 2.2MB, the rest being the ~79 unused Monarch
  grammars, the non-worker halves of the CSS and HTML language services, and
  the LSP client.
  `src/lib/monaco-setup.contributions.test.ts` builds a fixture from that
  file's own import list and asserts the emitted worker set (#1147). The
  specifiers themselves are monaco 0.56's supported entry points - `editor`,
  `features/<feature>/register`, `languages/definitions/<language>/register`,
  `languages/features/<service>/register` - because 0.56 put the package behind
  an `exports` map under which the older `esm/vs/...` paths resolve to
  `esm/vs/esm/vs/...` and fail (#1342)
- **`vayu:woff2-only`** (`vite-plugins/woff2-only.ts`): strips the legacy
  `.woff` source from the `@fontsource` stylesheets, which Chromium never asks
  for but Vite would otherwise emit alongside every woff2 (90 unreachable
  files, 1.18MB). It edits the assembled bundle rather than a `transform`, so
  it does not depend on which plugin inlines the `@import` tree;
  `src/fonts-woff2-only.test.ts` builds a fixture with and without it

## Dependencies

### Production Dependencies

- **React 19**: UI framework
- **Electron 28**: Desktop app framework
- **Zustand**: State management
- **TanStack Query**: Server state
- **Radix UI**: Component primitives
- **Tailwind CSS**: Styling
- **Monaco Editor**: Code editing
- **uPlot**: Charts
- **@fontsource** (Space Grotesk, Inter, JetBrains Mono, Fira Code, IBM Plex
  Mono, Space Mono): bundled font faces, imported from `src/fonts.css`

### Development Dependencies

- **TypeScript 7** (installed as `tsc7`): every compile - the `pnpm type-check`
  gate and the `build` / `electron:compile` emit - see
  [One compiler runs, two are installed](#one-compiler-runs-two-are-installed)
- **TypeScript 5.9**: invoked by nothing; kept for the `typescript-eslint`
  parser's peer range and for the Compiler API the `pm.*` doc-example test
  drives
- **`@types/node` 24**: held at the major Electron's bundled Node is (44 ships
  Node 24.x), not the newest published. Types ahead of the runtime describe
  APIs `electron/` can call and the shipped app then does not have, and the
  main process is the code that consumes them. Bump this when Electron's Node
  major moves, not when DefinitelyTyped's does
- **Vite**: Build tool
- **ESLint 10**: Linting, with `@eslint/js` and `eslint-config-prettier` on
  their own 10.x lines. `eslint:recommended` gained `no-unassigned-vars`,
  `no-useless-assignment` and `preserve-caught-error` in 10.0, and the 9.x line
  went end-of-life on 2026-08-06
- **Electron Builder**: Packaging

## Troubleshooting

### Engine Not Found

**Error**: `Engine binary not found at: ...`

**Solution**: Build the engine first, or ensure binary is in correct location:
- Development: `engine/build/vayu-engine` (or `Debug/vayu-engine.exe` on Windows)
- Production: `app/build/resources/bin/vayu-engine`

### Port Already in Use

**Error**: `Port 9876 is already in use`

**Solution**: 
```bash
# Kill process on port 9876
pnpm kill-ports
# Or manually:
# macOS/Linux: lsof -ti:9876 | xargs kill
# Windows: netstat -ano | findstr :9876
```

### Build Fails

**Error**: TypeScript errors or missing dependencies

**Solution**:
```bash
# Clean and reinstall
rm -rf node_modules pnpm-lock.yaml
pnpm install

# Check TypeScript errors
pnpm type-check
```

### Electron Window Blank

**Error**: Window opens but shows blank screen

**Solution**:
- Check if Vite dev server is running on port 5173
- Check console for errors
- Verify `main.ts` is loading correct URL (`http://localhost:5173` in dev)

## Platform-Specific Notes

### macOS

- Requires entitlements for hardened runtime
- DMG includes Applications folder link
- Universal binary support (x64 + ARM64)

### Windows

- NSIS installer with custom script (`build/installer.nsh`)
- Creates desktop and Start Menu shortcuts
- Uninstaller included

### Linux

- AppImage: Portable, no installation needed
- Debian package: System integration, desktop file

## CI/CD Integration

For automated builds, see `.github/workflows/release.yml` which uses:

- CMake presets for cross-platform builds
- lukka/run-vcpkg for dependency management
- lukka/run-cmake for building with presets
- Automated artifact collection and release publishing

The workflow handles:
1. Building engine with tests
2. Copying engine binary to app resources
3. Building and packaging the Electron app
4. Creating GitHub releases

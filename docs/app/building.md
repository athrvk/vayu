# Building Vayu App

This document outlines how to build the Vayu Manager Electron application from source.

## Prerequisites

- **Node.js**: Version ≥ 20 LTS
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
└── tsconfig.node.json  # TypeScript config (Electron)
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
| `pnpm type-check` | TypeScript type checking |
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

**Main Process (Electron):**
- Use VS Code debugger with launch configuration
- Or use `console.log()` (outputs to terminal)

**Engine:**
- Engine logs appear in Electron main process console
- Check `engine/data/` for database and log files

## Production Build

### Build Steps

1. **Build the engine** (see `docs/engine/building.md`):
   ```bash
   cd engine
   ./scripts/build/build-and-test.sh
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

Production builds are output to `app/release/`:

- **macOS**: `Vayu-0.1.1-universal.dmg`
- **Windows**: `Vayu Setup 0.1.1.exe` (NSIS installer)
- **Linux**: `Vayu-0.1.1.AppImage` and `vayu-client_0.1.1_amd64.deb`

### Electron Builder Configuration

Configuration is in `electron-builder.json`:

- **macOS**: DMG with universal binary, code signing (if configured)
- **Windows**: NSIS installer with custom installer script
- **Linux**: AppImage and Debian package

**Key Settings:**
- App ID: `com.vayu.client`
- Product Name: `Vayu`
- Engine binary: Packaged in `resources/bin/` (copied to `bin/` in app)

## TypeScript Configuration

### React App (`tsconfig.json`)

- Target: ES2020
- Module: ESNext
- JSX: React
- Path aliases: `@/*` → `src/*`

### Electron (`tsconfig.node.json`)

- Target: ES2020
- Module: CommonJS (for Electron compatibility)
- Includes `electron/` directory

## Vite Configuration

Key settings in `vite.config.ts`:

- **Base**: `./` (relative paths for Electron)
- **Port**: 5173 (dev server)
- **Aliases**: Path shortcuts (`@/components`, `@/stores`, etc.)
- **Code Splitting**: React vendor and charts in separate chunks

## Dependencies

### Production Dependencies

- **React 19**: UI framework
- **Electron 28**: Desktop app framework
- **Zustand**: State management
- **TanStack Query**: Server state
- **Radix UI**: Component primitives
- **Tailwind CSS**: Styling
- **Monaco Editor**: Code editing
- **Recharts**: Charts

### Development Dependencies

- **TypeScript 5**: Type checking
- **Vite**: Build tool
- **ESLint**: Linting
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

For automated builds, ensure:

1. Engine is built first
2. Engine binary is copied to `app/build/resources/bin/`
3. All dependencies are installed (`pnpm install`)
4. Build command: `pnpm electron:build`

Example GitHub Actions workflow:
```yaml
- name: Build Engine
  run: cd engine && ./scripts/build/build-and-test.sh

- name: Copy Engine Binary
  run: |
    mkdir -p app/build/resources/bin
    cp engine/build/vayu-engine app/build/resources/bin/

- name: Build App
  run: cd app && pnpm electron:build
```

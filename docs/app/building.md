# Building Vayu Manager from Source

**Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Prerequisites

### All Platforms

- **Node.js** - ≥20 LTS
- **pnpm** - ≥8.x

### macOS

```bash
# Install via Homebrew
brew install node
npm install -g pnpm
```

### Linux (Ubuntu/Debian)

```bash
# Install Node.js (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm
```

### Windows

```powershell
# Install via winget
winget install OpenJS.NodeJS.LTS

# Install pnpm
npm install -g pnpm
```

---

## Clone Repository

```bash
git clone https://github.com/vayu/vayu.git
cd vayu/app
```

---

## Install Dependencies

```bash
pnpm install
```

This installs:
- React 18 and related dependencies
- Electron and Electron Builder
- Build tools and bundlers
- Development dependencies

---

## Development Mode

### Start Development Server

```bash
pnpm dev
```

This will:
1. Start Vite dev server on `http://localhost:5173`
2. Launch Electron window
3. Enable hot module replacement (HMR)
4. Reload on file changes

### Development Workflow

In VS Code or your editor:

```bash
# Terminal 1: Start Electron (with HMR)
pnpm dev

# Terminal 2: (Optional) Run engine separately
../engine/build/vayu-engine

# Edit React components → Auto-reload in Electron window
```

---

## Build for Production

### Build Renderer (React)

```bash
# Optimize and bundle React for production
pnpm build
```

Outputs to `dist/` directory.

### Package Application

```bash
# Build + Package for current platform
pnpm package
```

This creates:
- macOS: `Vayu.app` inside `dist/mac-universal`
- Windows: `Vayu-Setup.exe`
- Linux: `AppImage` and `.deb`

### Full Distribution Build

```bash
# Build, package, and create installers/updates
pnpm dist
```

---

## Platform-Specific Builds

### macOS (Universal - Intel + Apple Silicon)

```bash
pnpm dist:mac
```

Creates:
- `Vayu.app` (Universal)
- `Vayu-0.1.0-universal.dmg` (Installer)
- `Vayu-0.1.0-universal.zip`
- `latest-mac.yml` (Auto-update manifest)

### macOS (Intel Only)

```bash
pnpm dist:mac:x64
```

### macOS (Apple Silicon Only)

```bash
pnpm dist:mac:arm64
```

### Windows

```bash
pnpm dist:win
```

Creates:
- `Vayu Setup 0.1.0.exe`
- `Vayu 0.1.0.exe` (Portable)
- `latest.yml` (Auto-update)

### Linux

```bash
pnpm dist:linux
```

Creates:
- `.AppImage`
- `.deb` (Debian/Ubuntu)
- `latest-linux.yml`

---

## Project Structure

```
app/
├── electron/                  # Electron main process
│   ├── main.ts              # Window creation, lifecycle
│   ├── preload.ts           # Secure IPC bridge
│   └── sidecar.ts           # Engine process management
├── src/                       # React source
│   ├── App.tsx              # Root component
│   ├── main.tsx             # Entry point
│   ├── components/          # UI components
│   │   ├── RequestBuilder.tsx
│   │   ├── ResponseViewer.tsx
│   │   └── ...
│   ├── hooks/               # Custom React hooks
│   │   ├── useEngine.ts     # Engine communication
│   │   ├── useSSE.ts        # SSE stats stream
│   │   └── ...
│   ├── stores/              # Zustand state management
│   │   ├── collectionStore.ts
│   │   ├── environmentStore.ts
│   │   └── ...
│   └── styles/              # TailwindCSS styles
├── public/                    # Static assets
├── package.json             # Dependencies
├── tsconfig.json            # TypeScript config
├── vite.config.ts           # Vite bundler config
├── electron-builder.json    # Build configuration
└── dist/                    # Output directory (ignored)
```

---

## Configuration

### Vite (`vite.config.ts`)

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
```

### Electron Builder (`electron-builder.json`)

```json
{
  "productName": "Vayu",
  "appId": "com.vayu.app",
  "directories": {
    "buildResources": "assets",
    "output": "dist"
  },
  "mac": {
    "target": ["dmg", "zip"],
    "category": "public.app-category.utilities"
  },
  "win": {
    "target": ["nsis", "portable"]
  },
  "linux": {
    "target": ["AppImage", "deb"]
  }
}
```

---

## Scripts

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start dev server with Electron |
| `pnpm build` | Build React for production |
| `pnpm package` | Build + package for current platform |
| `pnpm dist` | Full distribution build (all platforms) |
| `pnpm dist:mac` | macOS build |
| `pnpm dist:win` | Windows build |
| `pnpm dist:linux` | Linux build |
| `pnpm lint` | Run ESLint |
| `pnpm type-check` | Run TypeScript check |

---

## Environment Setup

### Engine Binary

Vayu Manager needs the engine binary. It looks in:

```
<app-root>/resources/bin/vayu-engine
```

To provide the engine:

1. **Development:** Copy from engine build:
```bash
cp ../engine/build/vayu-engine ./resources/bin/
```

2. **Distribution:** Include in `electron-builder.json`:
```json
{
  "files": [
    "resources/bin/vayu-engine",
    "..."
  ]
}
```

---

## Troubleshooting

### Blank window on startup

**Solution:** Check DevTools (`Cmd+Opt+I` or `Ctrl+Shift+I`)

Look for errors. Common issues:
- Engine not running
- Engine binary not found
- Port 9876 already in use

---

### Hot reload not working

**Solution:** Ensure Vite dev server is running

```bash
pnpm dev  # Starts both Vite and Electron
```

---

### Build fails with "permission denied"

**Solution (macOS):**
```bash
xattr -cr /Applications/Vayu.app
```

---

### Module not found errors

**Solution:** Clear and reinstall dependencies

```bash
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

---

## IDE Setup

### VS Code

Install extensions:
- ES7+ React/Redux/React-Native snippets
- Vite
- Electron DevTools
- TailwindCSS IntelliSense

`.vscode/settings.json`:
```json
{
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  },
  "eslint.validate": [
    "typescript",
    "typescriptreact"
  ]
}
```

---

*See: [Getting Started](../getting-started.md) | [Engine Building](../engine/building.md) →*

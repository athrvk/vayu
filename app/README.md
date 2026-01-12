# Vayu Desktop App

API testing and load testing platform built with Electron + React + TypeScript.

## Prerequisites

- Node.js ≥ 20 LTS
- pnpm ≥ 8
- Vayu Engine running on `localhost:9876`

## Quick Start

```bash
pnpm install
pnpm dev              # Browser only
pnpm electron:dev     # Full Electron app
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Vite dev server |
| `pnpm electron:dev` | Start Electron with hot reload |
| `pnpm build` | Build for production |
| `pnpm electron:build` | Build Electron installer |
| `pnpm type-check` | TypeScript type checking |
| `pnpm lint` | Run ESLint |

## Project Structure

```
src/
├── components/        # React components
│   ├── layout/        # Shell, Sidebar
│   ├── collections/   # Collection tree
│   ├── request-builder/  # Request editor
│   ├── load-test-dashboard/  # Live metrics
│   ├── history/       # Run history
│   ├── variables/     # Variable editors
│   └── ui/            # Shared UI primitives
├── stores/            # Zustand stores
├── queries/           # TanStack Query hooks
├── hooks/             # Custom hooks
├── services/          # API client
├── types/             # TypeScript types
└── config/            # Configuration

electron/
├── main.ts            # Main process
└── preload.ts         # Preload script
```

## Tech Stack

- **React 18** + **TypeScript 5**
- **Electron 28**
- **Zustand** (UI state)
- **TanStack Query** (server state)
- **Tailwind CSS** + **Radix UI**
- **Monaco Editor** (code editing)
- **Recharts** (charts)
- **Vite** (build)

## Key Stores

| Store | Purpose |
|-------|---------|
| `useAppStore` | Navigation, screen state |
| `useDashboardStore` | Load test metrics |
| `useEnvironmentStore` | Active environment |
| `useVariablesStore` | Variable scope context |
| `useHistoryStore` | History filtering |
| `useCollectionsStore` | Collections state |
| `useSaveStore` | Auto-save state |

## Key Hooks

| Hook | Purpose |
|------|---------|
| `useEngine()` | Execute requests, start load tests |
| `useSSE()` | Stream real-time metrics |
| `useVariableResolver()` | Resolve `{{variables}}` |
| `useSaveManager()` | Auto-save orchestration |

## Troubleshooting

**Engine not connecting:** Ensure engine is running on port 9876

**SSE not working:** Only works during active load tests

## License

MIT

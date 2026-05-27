# Vayu Client App

API testing and load testing platform built with Electron + React + TypeScript.

## Prerequisites

- Node.js ≥ 20 LTS
- pnpm ≥ 10
- Vayu Engine running on `localhost:9876`

## Quick Start

```bash
pnpm install
pnpm dev              # Browser only
pnpm electron:dev     # Full Electron app
```

## Scripts

| Command               | Description                    |
| --------------------- | ------------------------------ |
| `pnpm dev`            | Start Vite dev server          |
| `pnpm electron:dev`   | Start Electron with hot reload |
| `pnpm build`          | Build for production           |
| `pnpm electron:build` | Build Electron installer       |
| `pnpm type-check`     | TypeScript type checking       |
| `pnpm lint`           | Run ESLint                     |

## Project Structure

```
src/
├── components/        # App-shell layout, status, shared response viewer, UI primitives
│   ├── layout/        # Shell, Sidebar, TitleBar
│   ├── shared/        # Shared response viewer
│   ├── status/        # ConnectionStatus
│   └── ui/            # Radix-based primitives (button, select, resizable, …)
├── modules/           # Feature modules (each self-contained)
│   ├── request-builder/   # Request editor, URL bar, body/auth/script panels
│   ├── collections/       # Collection tree, import modal, collection detail
│   ├── dashboard/         # Live load-test metrics
│   ├── history/           # Run history list + detail
│   ├── variables/         # Variable table editor
│   ├── settings/          # Settings panels
│   └── welcome/           # Welcome screen
├── lib/               # Shared libraries
│   ├── graphql/       # GraphQL diagnostics, introspection, schema cache, Monaco providers
│   └── monaco-setup.ts    # Monaco local-bundle config + GraphQL provider registration
├── stores/            # Zustand stores (UI state)
├── queries/           # TanStack Query hooks (server state)
├── hooks/             # Custom hooks
├── services/          # API client, SSE client, importers
├── types/             # TypeScript types
└── config/            # Configuration

electron/
├── main.ts            # Main process
└── preload.ts         # Preload script
```

## Tech Stack

- **React 19** + **TypeScript 5**
- **Electron 39**
- **Zustand** (UI state)
- **TanStack Query** (server state)
- **Tailwind CSS v4** + **Radix UI**
- **Monaco Editor** (code editing — JSON, scripts, GraphQL with language service)
- **Recharts** (charts)
- **Vite** (build)

## Key Stores

| Store                 | Purpose                              |
| --------------------- | ------------------------------------ |
| `useAppStore`         | Navigation, screen state             |
| `useDashboardStore`   | Load test metrics                    |
| `useVariablesStore`   | Variable scope context               |
| `useHistoryStore`     | History filtering                    |
| `useCollectionsStore` | Collection tree expansion state      |
| `useSaveStore`        | Auto-save state                      |
| `useSchemaCache`      | GraphQL schema introspection cache   |

## Key Hooks

| Hook                    | Purpose                            |
| ----------------------- | ---------------------------------- |
| `useEngine()`           | Execute requests, start load tests |
| `useSSE()`              | Stream real-time metrics           |
| `useVariableResolver()` | Resolve `{{variables}}`            |
| `useSaveManager()`      | Auto-save orchestration            |

## Troubleshooting

**Engine not connecting:** Ensure engine is running on port 9876

**SSE not working:** Only works during active load tests

## License

Apache-2.0

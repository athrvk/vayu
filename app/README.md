# Vayu Desktop Application

High-performance API testing platform built with Electron + React + TypeScript.

## Prerequisites

- Node.js ≥ 20 LTS
- pnpm ≥ 8
- Vayu Engine running on port 9876

## Installation

```bash
cd app
pnpm install
```

## Development

```bash
# Start Vite dev server only (for browser development)
pnpm dev

# Start Electron app with hot reload (full desktop app)
pnpm electron:dev
```

Make sure the Vayu engine is running:

```bash
cd ../engine
# Build and run the engine (see engine/README.md)
```

## Build for Production

```bash
# Build React app
pnpm build

# Create Electron installer
pnpm electron:build
```

## Project Structure

```
app/
├── src/
│   ├── components/       # React components
│   │   ├── Shell.tsx              # Main layout
│   │   ├── Sidebar.tsx            # Navigation sidebar
│   │   ├── CollectionTree.tsx     # Collections browser
│   │   ├── RequestBuilder.tsx     # Request editor
│   │   ├── ResponseViewer.tsx     # Response display
│   │   ├── LoadTestDashboard.tsx  # Real-time metrics
│   │   ├── HistoryList.tsx        # Run history
│   │   ├── EnvironmentManager.tsx # Variables management
│   │   └── ...
│   ├── stores/           # Zustand state management
│   ├── hooks/            # Custom React hooks
│   ├── services/         # API client & SSE
│   ├── types/            # TypeScript definitions
│   ├── utils/            # Helper functions
│   ├── App.tsx           # Root component
│   ├── main.tsx          # React entry point
│   └── index.css         # Global styles
├── electron/
│   ├── main.ts           # Electron main process
│   └── preload.ts        # Preload script
├── public/               # Static assets
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

## Architecture

### Data Flow

```
User Action
    ↓
React Component
    ↓
Zustand Store (State Management)
    ↓
Custom Hook (Business Logic)
    ↓
API Service (HTTP Client)
    ↓
Vayu Engine (Backend)
    ↓
SQLite Database
```

### Key Features

- **Auto-save**: Request changes saved automatically after 5 seconds
- **Real-time Streaming**: Load test metrics via Server-Sent Events (SSE)
- **Environment Variables**: Support for `{{variableName}}` substitution
- **Test Scripting**: Pre-request and test scripts using QuickJS
- **Run History**: Complete history with search and filtering

## Development Tips

### State Management

All state is managed with Zustand stores:

- `useAppStore` - Navigation and global state
- `useCollectionsStore` - Collections and requests
- `useRequestBuilderStore` - Request editor state
- `useDashboardStore` - Load test metrics
- `useHistoryStore` - Run history
- `useEnvironmentStore` - Environment variables

### API Integration

Use custom hooks for backend communication:

- `useEngine()` - Execute requests and start load tests
- `useSSE()` - Stream real-time metrics
- `useCollections()` - Manage collections/requests
- `useRuns()` - Load run history
- `useAutoSave()` - Auto-save functionality
- `useHealthCheck()` - Monitor engine connection

### Component Guidelines

1. Keep components focused and single-responsibility
2. Use TypeScript strictly (no `any` types)
3. Extract reusable logic into custom hooks
4. Use Zustand for shared state, local state for UI-only state
5. Follow the existing component patterns

## Testing

```bash
# Type checking
pnpm type-check

# Linting
pnpm lint
```

## Troubleshooting

### "Cannot connect to Vayu Engine"

- Ensure the engine is running: `cd ../engine && ./build/vayu`
- Check that port 9876 is not blocked

### Auto-save not working

- Check browser console for errors
- Verify request has an `id` field
- Ensure there are actual changes to save

### SSE connection issues

- SSE only works with running load tests
- Check that the run ID is valid
- Verify no firewall blocking port 9876

## License

MIT

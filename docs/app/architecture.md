# Manager (App) Architecture

**Document Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Overview

The Vayu Manager is an Electron + React application that provides a graphical interface for API testing and load testing. It communicates with the Engine via HTTP and SSE.

```
┌──────────────────────────────────────────┐
│        React Components (Renderer)       │
├──────────────────────────────────────────┤
│  RequestBuilder  │  ResponseViewer       │
│  Dashboard       │  Settings             │
│  Collections     │  Environments         │
└──────────────┬───────────────────────────┘
               │ (State via Zustand)
┌──────────────▼───────────────────────────┐
│        Custom React Hooks                │
├──────────────────────────────────────────┤
│  useEngine       │  useSSE               │
│  useCollection   │  useEnvironment       │
└──────────────┬───────────────────────────┘
               │ (HTTP/SSE to Engine)
┌──────────────▼───────────────────────────┐
│   Electron IPC + HTTP Bridge             │
├──────────────────────────────────────────┤
│  Main Process    │  HTTP Client          │
│  (Node.js)       │  (fetch API)          │
└──────────────┬───────────────────────────┘
               │ (localhost:9876)
               ▼
         Vayu Engine (C++)
```

---

## Technology Stack

### Frontend (Renderer Process)

| Technology | Purpose |
|-----------|---------|
| **React 18** | UI framework |
| **TypeScript** | Type safety |
| **Zustand** | State management |
| **React Query** | Server state caching |
| **TailwindCSS** | Styling |
| **Vite** | Build tool |

### Desktop (Main Process)

| Technology | Purpose |
|-----------|---------|
| **Electron** | Cross-platform desktop |
| **Node.js** | Runtime for main process |
| **child_process** | Engine process spawning |

---

## Component Architecture

### Request Builder

**File:** `src/components/RequestBuilder.tsx`

Handles:
- URL input with variable substitution
- HTTP method selection
- Header management
- Body editor (JSON, text, form, etc.)
- Authentication configuration

```tsx
function RequestBuilder() {
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [body, setBody] = useState('');
  
  return (
    <div className="request-builder">
      {/* Method selector */}
      {/* URL input */}
      {/* Headers table */}
      {/* Body editor */}
    </div>
  );
}
```

### Response Viewer

**File:** `src/components/ResponseViewer.tsx`

Displays:
- HTTP status with color coding
- Response headers
- Pretty-printed JSON body
- Response timing (DNS, TLS, TTFB, etc.)
- Test results with pass/fail indicators

### Dashboard

**File:** `src/components/Dashboard.tsx`

Real-time load test stats:
- RPS (requests per second)
- Latency percentiles (p50, p95, p99)
- Error rates and types
- Throughput (MB/s)
- Active connections

Connected to SSE stream from engine.

---

## State Management (Zustand)

### Collection Store

```typescript
// stores/collectionStore.ts
export const useCollectionStore = create((set) => ({
  collections: [],
  activeCollection: null,
  
  loadCollection: (path: string) => { /* ... */ },
  saveCollection: () => { /* ... */ },
  addRequest: (req: Request) => { /* ... */ },
}));
```

### Environment Store

```typescript
// stores/environmentStore.ts
export const useEnvironmentStore = create((set) => ({
  environments: [],
  activeEnvironment: null,
  
  setVariable: (key: string, value: string) => { /* ... */ },
  loadEnvironment: (path: string) => { /* ... */ },
}));
```

### Engine Store

```typescript
// stores/engineStore.ts
export const useEngineStore = create((set) => ({
  engineStatus: 'offline',
  currentRun: null,
  stats: null,
  
  connectToEngine: () => { /* ... */ },
  executeRequest: (req: Request) => { /* ... */ },
}));
```

---

## Custom Hooks

### useEngine

```typescript
// hooks/useEngine.ts
function useEngine() {
  const [connected, setConnected] = useState(false);
  
  const executeRequest = async (request: Request) => {
    const response = await fetch('http://127.0.0.1:9876/request', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return response.json();
  };
  
  const startLoadTest = async (request: Request, config: LoadConfig) => {
    const res = await fetch('http://127.0.0.1:9876/run', {
      method: 'POST',
      body: JSON.stringify({ request, config }),
    });
    const { runId } = await res.json();
    return runId;
  };
  
  return { connected, executeRequest, startLoadTest };
}
```

### useSSE

```typescript
// hooks/useSSE.ts
function useSSE(runId: string) {
  const [stats, setStats] = useState(null);
  
  useEffect(() => {
    const eventSource = new EventSource(
      `http://127.0.0.1:9876/stats/${runId}`
    );
    
    eventSource.addEventListener('stats', (e) => {
      setStats(JSON.parse(e.data));
    });
    
    return () => eventSource.close();
  }, [runId]);
  
  return stats;
}
```

---

## Electron IPC

### Main Process (`electron/main.ts`)

Responsible for:
- Window lifecycle
- Sidecar engine management
- File system operations
- Quit/shutdown

```typescript
import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'child_process';

let engineProcess: ChildProcess;

// Start engine on app launch
app.on('ready', () => {
  engineProcess = spawn(getEngineBinary(), []);
  createWindow();
});

// Clean shutdown
app.on('quit', () => {
  engineProcess.kill();
});

ipcMain.handle('save-collection', (event, data) => {
  // Save to filesystem
});
```

### Preload Script (`electron/preload.ts`)

Secure bridge between renderer and main:

```typescript
contextBridge.exposeInMainWorld('electron', {
  saveFile: (path: string, data: string) =>
    ipcRenderer.invoke('save-file', path, data),
  openFile: (path: string) =>
    ipcRenderer.invoke('open-file', path),
});
```

### Renderer Usage

```typescript
// In React component
const saved = await window.electron.saveFile(
  `./collections/${name}.json`,
  JSON.stringify(collection)
);
```

---

## Data Flow

### Execute Single Request

```
[User clicks Send]
     │
     ▼
[RequestBuilder state]
     │
     ├─► Substitute variables
     ├─► Prepare headers
     ├─► Encode body
     │
     ▼
[useEngine.executeRequest()]
     │
     ├─► HTTP POST /request
     │
     ▼
[Engine processes]
     │
     ├─► Run pre-script
     ├─► Send HTTP request
     ├─► Run post-script
     │
     ▼
[Engine returns response]
     │
     ▼
[ResponseViewer displays]
     │
     ├─► Status + headers
     ├─► Body (pretty-printed)
     ├─► Timing breakdown
     ├─► Test results
```

### Load Test (Async)

```
[User clicks "Start Load Test"]
     │
     ▼
[useEngine.startLoadTest()]
     │
     ├─► HTTP POST /run (returns runId)
     │
     ▼
[useSSE(runId)] (starts EventSource)
     │
     ├─► Engine sends `stats` events (~100ms)
     ├─► Dashboard updates in real-time
     │
     ▼
[EventSource `complete` event]
     │
     ├─► Final summary
     ├─► Store results
```

---

## File Organization

```
src/
├── App.tsx                  # Root
├── main.tsx                 # Entry
├── components/
│   ├── RequestBuilder.tsx
│   ├── ResponseViewer.tsx
│   ├── Dashboard.tsx
│   ├── Collections.tsx
│   └── Settings.tsx
├── hooks/
│   ├── useEngine.ts
│   ├── useSSE.ts
│   ├── useCollection.ts
│   └── useEnvironment.ts
├── stores/
│   ├── collectionStore.ts
│   ├── environmentStore.ts
│   └── engineStore.ts
├── types/
│   ├── request.ts
│   ├── response.ts
│   └── api.ts
└── styles/
    └── globals.css
```

---

## Performance Optimizations

### Code Splitting

Routes are lazy-loaded:

```typescript
const Dashboard = lazy(() => import('./Dashboard'));
const Collections = lazy(() => import('./Collections'));
```

### Memoization

Expensive computations are memoized:

```typescript
const ResponseStats = useMemo(() => 
  calculateStats(response),
  [response]
);
```

### Virtual Lists

Large collections use virtualization:

```typescript
<FixedSizeList
  height={600}
  itemCount={requests.length}
  itemSize={50}
>
  {RequestRow}
</FixedSizeList>
```

---

## Security

### Content Security Policy

```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; 
               script-src 'self' 'wasm-unsafe-eval';">
```

### No Remote Scripts

No inline scripts, no external CDN dependencies.

### Secure IPC

Preload script validates all messages:

```typescript
ipcRenderer.invoke('execute-script', { /* validated */ });
```

---

*See: [System Architecture](../architecture.md) | [Building App](building.md) →*

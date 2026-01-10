# Vayu Frontend Documentation

**Welcome to the Vayu Frontend Development Guide!**

This folder contains comprehensive documentation for building the Vayu Desktop Application (Electron + React + TypeScript).

---

## 📂 Documentation Overview

### **For Frontend Developers (UI/UX Focus)**

Start here if you're building the React components and UI:

1. **[UI-FLOW.md](UI-FLOW.md)** ⭐ START HERE

   - Complete user journey from app launch to load test results
   - All 5 major user flows with detailed UI mockups
   - State transitions and data flow diagrams
   - Key behaviors (auto-save, environment substitution, etc.)
   - **Reading time:** 20 minutes

2. **[COMPONENT-SPECS.md](COMPONENT-SPECS.md)**

   - Detailed specification for each React component
   - Props, state, behavior, and code examples
   - Component hierarchy and communication patterns
   - 8 core components fully specified
   - **Reading time:** 25 minutes

3. **[DATA-MODELS.md](DATA-MODELS.md)**
   - Complete TypeScript type definitions
   - All Request, Run, Response, and Environment types
   - UI state (Zustand store) architecture
   - Backend request/response payload types
   - **Reading time:** 15 minutes

---

### **For Backend Integration (Architecture Focus)**

Once you understand the UI, read these for integration details:

4. **[../INTEGRATION-PLAN.md](../INTEGRATION-PLAN.md)** (in `docs/app/`)

   - HTTP client setup and error handling
   - 6 custom hooks for backend communication
   - Zustand store architecture
   - Request/response lifecycle
   - Code examples for integration
   - **Reading time:** 20 minutes

5. **[../DEV-PHASES.md](../DEV-PHASES.md)** (in `docs/app/`)
   - 4-week Phase 1 implementation roadmap
   - Week-by-week tasks and deliverables
   - Phase 2 planned features
   - Testing strategy and success metrics
   - **Reading time:** 15 minutes

---

## 🎯 Quick Start (15 Minutes)

**New to the project? Follow this:**

1. Read **UI-FLOW.md** (understand the user experience)
2. Review **COMPONENT-SPECS.md** (understand the structure)
3. Skim **DATA-MODELS.md** (understand the data)
4. Skim **INTEGRATION-PLAN.md** (understand the API calls)
5. Check **DEV-PHASES.md** (understand the timeline)

**Then:** Start Week 1 tasks from DEV-PHASES.md

---

## 🏗️ Architecture at a Glance

```
User Interface (React Components)
       ↓
State Management (Zustand Stores)
       ↓
Custom Hooks (Backend Communication)
       ↓
HTTP Client
       ↓
Vayu Engine (C++ Daemon on Port 9876)
       ↓
Backend Database (SQLite)
```

---

## 🔄 Major User Flows

### **Flow 1: Single Request (Sanity Check)**

```
User fills request form
  ↓ Auto-save after 5 seconds
  ↓ [Send Request] button
  ↓ POST /request
  ↓ Display response with tests results
```

### **Flow 2: Load Test (Performance)**

```
User fills request form
  ↓ [Load Test] button
  ↓ Config dialog (duration, RPS, concurrency)
  ↓ [Start Load Test]
  ↓ POST /run
  ↓ Real-time Grafana-like dashboard
  ↓ GET /stats/:id (SSE stream, every 100ms)
  ↓ Final report on completion
```

### **Flow 3: View History**

```
Click "History" tab
  ↓ GET /runs
  ↓ Search/filter/sort past runs
  ↓ Click to view details
  ↓ GET /run/:id/report
  ↓ Display Grafana dashboard for that run
```

---

## 📊 Core Components (8 Total)

| Component                | Purpose              | Key Props                            |
| ------------------------ | -------------------- | ------------------------------------ |
| **Shell**                | App layout & routing | None (uses Zustand)                  |
| **CollectionTree**       | Navigate collections | collections, onSelectRequest         |
| **RequestBuilder**       | Edit request form    | requestId, collectionId              |
| **ResponseViewer**       | Display response     | response, isLoading                  |
| **LoadTestDashboard**    | Real-time metrics    | runId, mode ('running'\|'completed') |
| **HistoryList**          | Search/filter runs   | None (uses Zustand)                  |
| **EnvironmentManager**   | Manage variables     | None (uses Zustand)                  |
| **LoadTestConfigDialog** | Load test config     | requestId, environmentId, onStart    |

---

## 🗄️ Zustand Stores (5 Total)

| Store                | Purpose           | Key State                                      |
| -------------------- | ----------------- | ---------------------------------------------- |
| **AppState**         | Global navigation | activeSidebarTab, activeScreen, selectedIds    |
| **RequestStore**     | Request builder   | currentRequest, responseData, unsavedChanges   |
| **CollectionsStore** | Collections tree  | collections, selectedCollectionId              |
| **DashboardStore**   | Load test metrics | currentMetrics, historicalMetrics, finalReport |
| **HistoryStore**     | Run history       | runs, searchQuery, filters, sortOrder          |

---

## 🪝 Custom Hooks (6 Total)

| Hook                 | Purpose                       | Returns                                 |
| -------------------- | ----------------------------- | --------------------------------------- |
| **useEngine()**      | Execute requests & load tests | executeRequest, startLoadTest, stopTest |
| **useSSE()**         | Stream real-time metrics      | isConnected, error                      |
| **useCollections()** | Load collections tree         | collections, reload                     |
| **useRuns()**        | Load run history              | runs, loading, error, reload            |
| **useAutoSave()**    | Auto-save requests after 5s   | (side effect hook)                      |
| **useRunReport()**   | Fetch final test report       | report, loading, error                  |

---

## 🔌 Backend API Endpoints Used

**All endpoints on `http://127.0.0.1:9876`**

| Method | Endpoint                   | Purpose                             |
| ------ | -------------------------- | ----------------------------------- |
| GET    | `/health`                  | Health check                        |
| GET    | `/config`                  | Engine configuration                |
| GET    | `/collections`             | List collections                    |
| POST   | `/collections`             | Create/update collection            |
| GET    | `/requests?collectionId=X` | List requests in collection         |
| POST   | `/requests`                | Create/update request               |
| GET    | `/environments`            | List environments                   |
| POST   | `/environments`            | Create/update environment           |
| POST   | `/request`                 | Execute single request (sanity)     |
| POST   | `/run`                     | Start load test                     |
| GET    | `/runs`                    | List all runs (history)             |
| GET    | `/run/:id`                 | Get specific run                    |
| GET    | `/run/:id/report`          | Get detailed report (final metrics) |
| POST   | `/run/:id/stop`            | Stop running test                   |
| GET    | `/stats/:id`               | Stream metrics (SSE)                |

---

## 📈 Key Behaviors

### **Auto-Save**

- Request definition auto-saves after 5 seconds of inactivity
- Manual [Save] button always available
- Happens before [Send Request] or [Load Test]
- Backend stores in SQLite DB

### **Environment Substitution**

- Variables use `{{variableName}}` syntax
- Works in: URL, headers, body, scripts
- Substitution happens just before request sent
- Only one active environment at a time

### **Load Test Modes**

- **Constant (RPS):** Maintain fixed requests/second
- **Constant (Concurrency):** Fixed concurrent connections
- **Iterations:** Fixed total number of requests
- **Ramp-Up:** Gradually increase concurrency

### **Real-Time Metrics**

- Dashboard updates every ~100ms from SSE stream
- Metrics: RPS, errors, latency percentiles, throughput
- Charts: RPS over time, latency distribution
- Can switch to Request/Response view anytime

### **History Management**

- Every execution creates a run record (auto-saved)
- Search by name/ID
- Filter by type (Load/Sanity) and status
- Sort by date (newest/oldest)
- Delete individual runs with confirmation

---

## 🛠️ Development Setup

### **Prerequisites**

- Node.js ≥20 LTS
- pnpm 8+
- Git

### **Project Init (Week 1)**

```bash
cd app
pnpm init
pnpm add react react-dom zustand tailwindcss typescript
pnpm add -D vite @vitejs/plugin-react electron typescript

# Create configuration files
# See DEV-PHASES.md for detailed setup
```

### **Development Mode**

```bash
pnpm dev
# Starts Vite dev server + Electron with hot reload
```

### **Production Build**

```bash
pnpm build       # Bundle React
pnpm package     # Create installer
```

---

## 📚 Documentation Map

```
vayu/
├── app/docs/                          (UI/UX Documentation)
│   ├── README.md                      ← You are here
│   ├── UI-FLOW.md                     (User journeys)
│   ├── COMPONENT-SPECS.md             (Component details)
│   └── DATA-MODELS.md                 (Type definitions)
│
└── docs/app/                          (Integration & Planning)
    ├── INTEGRATION-PLAN.md            (Backend integration)
    ├── DEV-PHASES.md                  (4-week roadmap)
    └── FRONTEND-SUMMARY.md            (Complete overview)
```

---

## ✅ Reading Checklist

**For first-time readers:**

- [ ] Read UI-FLOW.md completely (20 min)
- [ ] Read COMPONENT-SPECS.md completely (25 min)
- [ ] Skim DATA-MODELS.md (15 min)
- [ ] Skim INTEGRATION-PLAN.md (10 min)
- [ ] Skim DEV-PHASES.md (10 min)
- [ ] Understand the 3 major flows
- [ ] Understand the 8 components
- [ ] Understand the 5 stores
- [ ] Understand the 6 hooks

**Time investment:** ~90 minutes

**After reading:** You should be able to start Week 1 tasks!

---

## ❓ Common Questions

**Q: Where should I store data?**
A: All persistence in backend (SQLite). Frontend only stores UI state in Zustand.

**Q: Can I add dark mode in Phase 1?**
A: No, Phase 2 feature. But we'll use TailwindCSS `dark:` variants from day one.

**Q: What about request templates?**
A: Phase 2 feature. Architecture designed to support later without refactoring.

**Q: Do I need to modify backend code?**
A: No! All backend APIs are ready. Frontend is standalone.

**Q: How often should I commit?**
A: After completing each small task. Clear commit messages.

**Q: What if the backend API changes?**
A: Update INTEGRATION-PLAN.md and custom hooks, then update components.

---

## 🚀 Ready to Code?

**Next step:** Review all documentation above.

**Then:** Start **Week 1** from `docs/app/DEV-PHASES.md`

**Questions?** Ask before starting coding!

---

## 📞 Documentation Issues?

If you find errors or clarifications needed in docs:

1. Note the issue
2. Create a GitHub issue tagged `documentation`
3. Suggest improvements

---

**Happy coding! 🎉**

_Last updated: January 3, 2026_

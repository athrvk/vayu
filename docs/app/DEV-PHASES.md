# Vayu Frontend - Development Phases

**Version:** 1.0  
**Last Updated:** January 3, 2026  
**Target:** Phase 1 MVP - 4 weeks

---

## 📅 Phase 1: MVP (4 Weeks)

### **Week 1: Foundation & Setup**

**Goals:** Setup project, Electron integration, basic infrastructure

**Tasks:**

- [ ] Initialize Electron + Vite + React project
- [ ] Setup TypeScript configuration
- [ ] Create folder structure
  - `src/components/`
  - `src/hooks/`
  - `src/stores/`
  - `src/types/`
  - `src/lib/`
  - `electron/`
  - `app/docs/`
- [ ] Setup Zustand stores (basic structure)
- [ ] Create HTTP client (`lib/httpClient.ts`)
- [ ] Create Shell component with sidebar layout
- [ ] Setup Electron sidecar manager to spawn engine
- [ ] Test engine connection (health check)

**Deliverables:**

- App launches with proper sidebar + content layout
- Sidebar shows placeholder for Collections/History/Settings
- Main content shows Welcome screen
- Health check confirms engine is running

**Dependencies:**

- npm/pnpm packages: electron, vite, react, zustand, tailwindcss, typescript

---

### **Week 2: Collections & Request Builder**

**Goals:** Implement request management UI

**Tasks:**

- [ ] Create `CollectionTree` component
  - Load from `GET /collections`
  - Display hierarchical structure
  - Handle folder expand/collapse
  - Click to select request
- [ ] Create `RequestBuilder` component
  - Display request form (method, URL, headers, body)
  - Tabs for Params, Headers, Body, Auth, Scripts
  - Auto-save after 5 seconds
  - Save button for manual save
- [ ] Load request definition on selection
  - `GET /requests?collectionId=X`
  - Populate form fields
- [ ] Create `ResponseViewer` component
  - Display response (status, headers, body, timing)
  - Tabs for Body, Headers, Cookies, Tests
  - Pretty-print JSON
- [ ] Setup environment selector
  - `GET /environments`
  - Display in dropdown
  - Store active environment in Zustand

**Deliverables:**

- Collections sidebar functional
- Request builder displays and allows editing
- Response viewer shows response after single request
- Auto-save works (verify in backend DB)

**Endpoints Used:**

- `GET /collections`
- `GET /requests?collectionId=X`
- `GET /environments`
- `POST /request` (single execution)
- `POST /requests` (save request definition)

---

### **Week 3: Load Testing & Dashboard**

**Goals:** Implement load test configuration and real-time metrics

**Tasks:**

- [ ] Create `LoadTestConfigDialog`
  - Duration, RPS/Concurrency, ramp-up options
  - Validation
  - Submit to start test
- [ ] Create `LoadTestDashboard`
  - Key metrics display (RPS, errors, total)
  - Latency percentiles (p50, p95, p99)
  - Progress bar (elapsed/duration)
  - Action buttons (View Request, Stop, Back)
- [ ] Implement `useSSE` hook
  - Connect to `GET /stats/:runId`
  - Update metrics every ~100ms
  - Handle completion event
- [ ] Implement `useRunReport` hook
  - Fetch `GET /run/:runId/report` on completion
  - Populate final dashboard
- [ ] Create charts/visualizations
  - RPS over time (line chart)
  - Latency distribution (histogram/area)
  - Error breakdown table
- [ ] Implement load test flow
  - Config dialog → POST /run → Dashboard → Final report

**Deliverables:**

- Load test config dialog fully functional
- Real-time metrics dashboard shows live data
- Charts update smoothly
- Stop button works (POST /run/:id/stop)
- Final report displays accurately

**Endpoints Used:**

- `POST /run` (start load test)
- `GET /stats/:id` (SSE stream)
- `GET /run/:id/report` (final results)
- `POST /run/:id/stop` (cancel test)

---

### **Week 4: History & Polish**

**Goals:** Implement history viewer and finalize MVP

**Tasks:**

- [ ] Create `HistoryTab` component
  - `GET /runs` to list all runs
  - Display table with run metadata
  - Type filter (Load/Sanity)
  - Status filter (Completed/Failed)
  - Date sort (Newest/Oldest)
  - Search by name/ID
- [ ] Create `HistoryDetail` view
  - Click run to view details
  - Display Grafana dashboard with that run's metrics
  - Delete button
- [ ] Create `SettingsTab`
  - Display engine status (version, workers, connection)
  - Environment variable management (CRUD)
  - Global settings (timeout, follow redirects)
- [ ] Polish & bug fixes
  - Error handling for all flows
  - Loading states
  - Empty state messages
  - Responsive design (testing on Windows)
- [ ] Documentation
  - README for development
  - Contributing guide
  - Architecture diagram

**Deliverables:**

- History tab shows all runs with filtering/search
- View past run details with Grafana dashboard
- Settings panel functional
- No major bugs/errors
- App usable on Windows (dev tested)

**Endpoints Used:**

- `GET /runs`
- `GET /run/:id/report`
- `GET /config`
- `POST/GET /environments`

---

## 📊 Phase 1 Feature Matrix

| Feature                     | Week | Status      |
| --------------------------- | ---- | ----------- |
| App launch & Electron setup | 1    | In Planning |
| Collections sidebar         | 2    | In Planning |
| Request builder             | 2    | In Planning |
| Response viewer             | 2    | In Planning |
| Single request execution    | 2    | In Planning |
| Environments dropdown       | 2    | In Planning |
| Load test config            | 3    | In Planning |
| Real-time dashboard         | 3    | In Planning |
| Charts & visualization      | 3    | In Planning |
| History list & search       | 4    | In Planning |
| History detail view         | 4    | In Planning |
| Settings panel              | 4    | In Planning |
| Polish & testing            | 4    | In Planning |

---

## 📋 Phase 1 Daily Standup Template

**Format:** Each day, update progress on current week's tasks

```
## Day X - Current Status

### ✅ Completed Today
- [ ] Task from task list
- [ ] Task from task list

### 🔄 In Progress
- [ ] Task (% complete)
- [ ] Task (% complete)

### ⏸️ Blocked
- Task name - Reason

### 📝 Notes
- Any important context or decisions

### 🎯 Tomorrow's Plan
- [ ] Task 1
- [ ] Task 2
```

---

## 🔄 Phase 2: Polish & Optimization (Future)

**Planned for after Phase 1 MVP:**

### **Features:**

- [ ] Dark mode (use TailwindCSS `dark:` variants)
- [ ] Request templates/inheritance
- [ ] Postman collection import
- [ ] Export test results (JSON/CSV/PDF)
- [ ] Advanced data sampling settings (in load test config)
- [ ] Request history/undo
- [ ] Keyboard shortcuts
- [ ] Request groups/organization
- [ ] Custom middleware/interceptors
- [ ] Request scheduling
- [ ] WebSocket support
- [ ] Auto-update mechanism

### **Optimizations:**

- [ ] Memoize components (React.memo)
- [ ] Code splitting with dynamic imports
- [ ] Virtual scrolling for large history lists
- [ ] Caching SSE metrics
- [ ] Optimize chart re-renders

### **Infrastructure:**

- [ ] GitHub Actions CI/CD
- [ ] Code coverage tracking
- [ ] Performance monitoring
- [ ] Error tracking (Sentry)
- [ ] Release automation

---

## 🧪 Testing Strategy

### **Unit Tests (Phase 1)**

- Component render tests
- Zustand store logic
- HTTP client error handling
- Validation functions

### **Integration Tests (Phase 1)**

- Request builder → API → Response viewer flow
- Collections tree loading and navigation
- Environment variable substitution
- Load test lifecycle

### **E2E Tests (Phase 2)**

- Full user journey (welcome → request → test → history)
- Electron app launching
- Data persistence across sessions

### **Manual Testing (Phase 1)**

- Windows platform testing (yours)
- macOS platform testing (backend dev)
- Network failure scenarios
- Engine timeout handling
- Long-running load tests (30+ minutes)

---

## 📦 Build & Packaging

### **Development Mode**

```bash
pnpm dev
# Starts Vite dev server + Electron with HMR
```

### **Production Build**

```bash
pnpm build
# Bundles React app for production
pnpm package
# Creates platform-specific installers
```

### **Platform-Specific**

```bash
pnpm dist:mac      # macOS DMG/ZIP
pnpm dist:win      # Windows EXE/Portable
pnpm dist:linux    # Linux AppImage/DEB
```

**Phase 1:** Build only for development (pnpm dev)  
**Phase 2:** Add GitHub Actions for automated builds

---

## 💾 Database & Persistence

**All persistence is backend (SQLite):**

- Collections, Requests, Environments → Backend DB
- Run history → Backend DB
- Frontend only stores UI state (Zustand)

**No file system operations in Phase 1.**

Benefits:

- ✅ No complex file sync logic
- ✅ Multi-device sync becomes easier (Phase 2)
- ✅ Cleaner code
- ✅ Single source of truth

---

## 🐛 Known Issues & TODOs

### **Phase 1 TODOs**

- [ ] Question 2 from earlier: Request templates without code changes?
  - **Decision:** Mark as Phase 2 feature, architecture allows it
  - **Implementation plan:** Create `template` field on Request object later
- [ ] Data sampling settings visibility
  - **Decision:** Hide in Phase 1, expose as Advanced Settings in Phase 2
  - **Implementation:** Add toggle for "Advanced Settings" in LoadTestConfigDialog

---

## 📈 Success Metrics for Phase 1

### **Functional**

- ✅ App launches and connects to engine
- ✅ Collections load and display correctly
- ✅ Single request execution works (sanity check)
- ✅ Load test executes and streams real-time metrics
- ✅ History shows all past runs with search/filter
- ✅ No crashes or unhandled errors

### **Performance**

- ✅ App startup < 2 seconds
- ✅ Collections load < 500ms
- ✅ Dashboard updates smooth (60fps)
- ✅ History search/filter responsive

### **User Experience**

- ✅ Intuitive UI (no manual)
- ✅ Clear error messages
- ✅ Proper loading states
- ✅ Works on Windows + macOS

### **Code Quality**

- ✅ TypeScript strict mode
- ✅ No console errors/warnings
- ✅ Proper error boundaries
- ✅ Clean component structure

---

## 📚 Resources

**Documentation created:**

- `app/docs/UI-FLOW.md` - Complete user journeys
- `app/docs/COMPONENT-SPECS.md` - Component details
- `app/docs/DATA-MODELS.md` - Type definitions
- `docs/app/INTEGRATION-PLAN.md` - Backend integration
- `docs/app/DEV-PHASES.md` - This file

**Backend API Reference:**

- `docs/engine/api-reference.md` - Complete endpoint docs

**Architecture:**

- `docs/architecture.md` - System design
- `docs/engine/architecture.md` - Engine internals

---

## 🚀 Getting Started (Week 1)

```bash
# 1. Create app directory structure
mkdir -p app/src/{components,hooks,stores,types,lib}
mkdir -p app/electron
mkdir -p app/public

# 2. Initialize project
cd app
pnpm init
pnpm add react react-dom zustand tailwindcss typescript
pnpm add -D vite @vitejs/plugin-react electron

# 3. Create tsconfig.json, vite.config.ts, etc.

# 4. Start development
pnpm dev
```

**Week 1 ends when:**

- App launches with Shell layout
- Sidebar visible with placeholder content
- Health check confirms engine connection
- No TypeScript errors

---

## 📞 Questions Before Starting?

Before Week 1 begins, confirm:

1. ✅ Question 5 (data sampling) → Hide in Phase 1, expose in Phase 2
2. ✅ All UI flows approved → Ready to code
3. ✅ Data models correct → Ready to code
4. ✅ Integration plan clear → Ready to code
5. ✅ Development phases reasonable → Ready to code

**Any last clarifications needed?**

---

Ready to begin Phase 1 implementation!

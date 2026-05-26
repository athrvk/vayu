# PRD: Collection Import

## Problem Statement

Vayu has no import capability. Users migrating from Postman or Insomnia must recreate every request manually — a hard adoption blocker. API teams that standardise on OpenAPI specs also have no path to generate a working request collection in Vayu.

## Goal

Allow users to import request collections from external tools with a single file drop. The result should be immediately usable in Vayu with minimal post-import editing.

## Scope (V1)

| Format | Version | Source |
|---|---|---|
| Postman Collection | v2.1 | JSON export from Postman app |
| Postman Collection | v2.0 | JSON export from older Postman versions |
| Insomnia Export | v4 | JSON export from Insomnia app |
| OpenAPI / Swagger | 3.0.x | JSON or YAML spec file |
| OpenAPI / Swagger | 2.0 | JSON or YAML Swagger spec file |

**Deferred:** Bruno (non-JSON `.bru` DSL), Postman Environment files as standalone import, workspace-level Postman data exports.

## Entry Points

Two places trigger the import modal:

1. **Collections sidebar header** — download icon button (always accessible)
2. **Welcome screen** — "Import Collection" quick action button

## User Flow

```
User opens modal
  └─ Tab: File (default) | URL | Paste JSON

  [File tab]
    Drop zone → user drops or clicks to browse
    → Detecting… (spinner, ~900ms parse time)
    → Preview state

  [URL tab]
    Input URL → click Fetch
    → Engine proxies GET request (POST /import/fetch)
    → Detecting… → Preview state

  [Paste tab]
    Textarea → click "Detect & Preview"
    → Detecting… → Preview state

  [Preview state]
    Green badge: "✓ Postman Collection v2.1 · production-api.json"
    Tree preview: folders + request list (max-height scroll)
    Stats: "12 requests · 3 folders · 2 environments"
    Options:
      ☑ Import environments & variables
      ☑ Import pre-request & test scripts
    Buttons: [Cancel] [Import →]

  [Importing state]
    Button shows spinner + "Importing…"
    Sequential API calls to engine
    On complete: modal closes, collections sidebar refreshes
```

## Architecture

### Frontend — Factory Pattern

All parsing is done in the frontend (TypeScript). No new engine parsing logic needed for file/paste/URL-body content.

```
app/src/services/importers/
  types.ts          — ImportParser interface, ImportResult, ImportOptions
  factory.ts        — ImportParserFactory.detect(rawString) → ImportParser
  postman.ts        — PostmanV21Parser + PostmanV20Parser
  insomnia-v4.ts    — InsomniaV4Parser
  openapi-v3.ts     — OpenApiV3Parser
  openapi-v2.ts     — OpenApiV2Parser (Swagger)
  orchestrator.ts   — ImportOrchestrator: calls apiService sequentially

app/src/modules/collections/
  ImportModal.tsx   — Modal UI: tabs, drop zone, preview tree, options
```

### Core Interfaces

```typescript
interface ImportParser {
  readonly formatName: string;       // "Postman Collection v2.1"
  readonly formatKey: string;        // "postman-v21"
  detect(raw: string): boolean;      // Returns true if this parser owns this input
  parse(raw: string, opts: ImportOptions): ImportResult;
}

interface ImportResult {
  collections: CollectionDraft[];    // Root collections (parentId = null)
  environments: EnvironmentDraft[];
  meta: ImportMeta;
}

interface CollectionDraft {
  name: string;
  variables: Record<string, VariableValue>;
  children: CollectionDraft[];       // Sub-folders (recursive)
  requests: RequestDraft[];          // Requests directly in this collection
}

interface RequestDraft {
  name: string;
  method: HttpMethod;
  url: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  bodyType: "json" | "text" | "form-data" | "x-www-form-urlencoded" | "none";
  auth: Record<string, unknown>;
  preRequestScript: string;
  postRequestScript: string;
}

interface EnvironmentDraft {
  name: string;
  variables: Record<string, VariableValue>;
}

interface ImportMeta {
  format: string;
  fileName?: string;
  requestCount: number;
  folderCount: number;
  environmentCount: number;
}

interface ImportOptions {
  importEnvironments: boolean;       // Checkbox: "Import environments & variables"
  importScripts: boolean;            // Checkbox: "Import pre-request & test scripts"
}
```

### Engine — URL Proxy Endpoint

The URL import tab cannot fetch arbitrary URLs from the browser (CORS). The engine proxies it using its existing libcurl infrastructure.

```
POST /import/fetch
Body:  { "url": "https://petstore.swagger.io/v2/swagger.json" }
Response:
  200: { "content": "<raw body string>", "contentType": "application/json" }
  400: { "error": "Invalid URL" }
  502: { "error": "Failed to fetch: <curl error>" }
```

New file: `engine/src/http/routes/import.cpp`
Register in: `engine/src/http/server.cpp` + `engine/include/vayu/http/routes.hpp`

### Vayu Data Model Mapping

Vayu has no workspace concept. The mapping is:

| External concept | Vayu entity |
|---|---|
| Postman Collection / Insomnia Workspace / OpenAPI spec | Root `Collection` (parentId = null) |
| Postman Folder / Insomnia request_group / OpenAPI tag | Child `Collection` (parentId = parent id) |
| Request at any level | `Request` (collectionId = its immediate parent Collection) |
| Postman/Insomnia environment | `Environment` |

Root-level requests (directly in a Postman Collection outside any folder) get `collectionId = rootCollectionId`.

### Orchestrator Sequencing

Order matters because children reference parent IDs.

```
1. Create root Collection(s)
2. For each depth level (BFS): create child Collections with parentId
3. Create all Requests (parallelisable per-collection after its Collection exists)
4. If importEnvironments=true: create all Environments
5. Invalidate TanStack Query: queryKeys.collections, queryKeys.environments
```

## UI Reference

See `/design_handoff/vayu-app.jsx` → `ImportModal` component for pixel-precise design.

Key design tokens:
- Modal: 500px wide, `background: --card`, `border: 1px solid --border-strong`, `border-radius: 10px`
- Drop zone: `border: 2px dashed --border-strong`, drag-over → `border-color: --primary`
- Format badges: 10px, `background: --card`, `border: 1px solid --border`
- Preview tree: `background: --accent-hover`, max-height 190px scroll
- Detection badge (green): `background: rgba(34,197,94,0.08)`, `border: rgba(34,197,94,0.22)`

## Format Detection Order

The factory tries parsers in this order (most specific first):

1. Postman v2.1 — `info.schema` contains `"v2.1.0"`
2. Postman v2.0 — `info.schema` contains `"v2.0.0"` or has `info` + `item` but no schema
3. Insomnia v4 — `_type === "export"` AND `__export_format === 4`
4. OpenAPI 3.0 — `openapi` field starts with `"3."`
5. OpenAPI 2.0 — `swagger === "2.0"`

If no parser matches: show error state "Unrecognised format".

## Out of Scope (V1)

- Exporting collections from Vayu to Postman/Insomnia format
- Merging an import into an existing collection (always creates new)
- Incremental re-import / sync
- Bruno `.bru` format
- Postman standalone environment JSON import
- Postman workspace-level data export (ZIP)
- GraphQL-specific body type
- OAuth2 token execution (stored as JSON, not executed)

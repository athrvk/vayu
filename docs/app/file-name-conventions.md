# File Naming Conventions

This document defines the standard file naming conventions for the Vayu application codebase.

## General Principles

1. **Consistency**: All files of the same type should follow the same naming pattern
2. **Clarity**: File names should clearly indicate their purpose
3. **Convention**: Follow TypeScript/React community standards

## Naming Patterns by File Type

### Components (`.tsx`)

**Pattern:** `PascalCase.tsx`

**Examples:**
- `RequestBuilder.tsx`
- `HistoryList.tsx`
- `CollectionTree.tsx`
- `ErrorBoundary.tsx`
- `ConnectionStatus.tsx`

**Rationale:** React components are typically PascalCase, matching the component name.

---

### Hooks (`.ts`)

**Pattern:** `camelCase.ts` with `use` prefix

**Examples:**
- `useEngine.ts`
- `useSSE.ts`
- `useSaveManager.ts`
- `useVariableResolver.ts`
- `useHeadersManager.ts`

**Rationale:** React hooks convention requires `use` prefix and camelCase naming.

---

### Stores (`.ts`)

**Pattern:** `kebab-case-store.ts`

**Examples:**
- `navigation-store.ts`
- `engine-connection-store.ts`
- `variables-store.ts`
- `history-store.ts`
- `collections-store.ts`
- `dashboard-store.ts`
- `save-store.ts`
- `response-store.ts`

**Rationale:** Stores are utility modules, following kebab-case convention for consistency.

---

### Services (`.ts`)

**Pattern:** `kebab-case.ts` or `kebab-case-client.ts`

**Examples:**
- `http-client.ts`
- `sse-client.ts`
- `api.ts`
- `request-transformer.ts`
- `collection-transformer.ts`
- `run-report-transformer.ts`
- `globals-transformer.ts`

**Rationale:** Services are utility modules, following kebab-case for consistency.

---

### Queries (`.ts`)

**Pattern:** `kebab-case.ts`

**Examples:**
- `collections.ts`
- `runs.ts`
- `health.ts`
- `globals.ts`
- `environments.ts`
- `script-completions.ts`

**Rationale:** Query files are utility modules, following kebab-case convention.

---

### Types (`.ts`)

**Pattern:** `kebab-case.ts`

**Examples:**
- `api.ts`
- `domain.ts`
- `ui.ts`
- `types.ts` (barrel export)

**Rationale:** Type definition files follow kebab-case for consistency.

---

### Utils/Helpers (`.ts`)

**Pattern:** `kebab-case.ts`

**Examples:**
- `helpers.ts`
- `utils.ts`
- `key-value.ts`
- `request-state.ts`
- `system-headers.ts`
- `headers-format.ts`

**Rationale:** Utility files follow kebab-case convention.

---

### Constants (`.ts`)

**Pattern:** `kebab-case.ts`

**Examples:**
- `error-codes.ts`

**Rationale:** Constants files follow kebab-case convention.

---

### Config (`.ts`)

**Pattern:** `kebab-case.ts`

**Examples:**
- `api-endpoints.ts`

**Rationale:** Configuration files follow kebab-case convention.

---

### Errors (`.ts` / `.tsx`)

**Pattern:** 
- Components: `PascalCase.tsx` (e.g., `ErrorBoundary.tsx`)
- Utilities: `kebab-case.ts` (e.g., `error-handler.ts`, `error-logger.ts`)

**Examples:**
- `ErrorBoundary.tsx` (React component)
- `error-handler.ts` (utility functions)
- `error-logger.ts` (utility functions)

**Rationale:** Error components follow component naming, error utilities follow kebab-case.

---

### Index Files (`.ts` / `.tsx`)

**Pattern:** `index.ts` or `index.tsx`

**Examples:**
- `index.ts` (barrel exports)
- `index.tsx` (component barrel exports)

**Rationale:** Standard convention for barrel exports and directory entry points.

---

## Summary Table

| File Type | Pattern | Example |
|-----------|---------|---------|
| Components | `PascalCase.tsx` | `RequestBuilder.tsx` |
| Hooks | `camelCase.ts` (with `use` prefix) | `useEngine.ts` |
| Stores | `kebab-case-store.ts` | `navigation-store.ts` |
| Services | `kebab-case.ts` | `http-client.ts` |
| Transformers | `kebab-case-transformer.ts` | `request-transformer.ts` |
| Queries | `kebab-case.ts` | `collections.ts` |
| Types | `kebab-case.ts` | `api.ts` |
| Utils | `kebab-case.ts` | `helpers.ts` |
| Constants | `kebab-case.ts` | `error-codes.ts` |
| Config | `kebab-case.ts` | `api-endpoints.ts` |
| Error Components | `PascalCase.tsx` | `ErrorBoundary.tsx` |
| Error Utilities | `kebab-case.ts` | `error-handler.ts` |
| Index Files | `index.ts` / `index.tsx` | `index.ts` |

## Directory Structure

Files are organized by feature/domain in the `modules/` directory:

```
modules/
├── [module-name]/
│   ├── sidebar/          # Sidebar components (PascalCase.tsx)
│   ├── main/             # Main content components (PascalCase.tsx)
│   ├── components/       # Sub-components (PascalCase.tsx)
│   ├── types.ts          # Type definitions (kebab-case.ts)
│   └── index.ts          # Barrel exports
```

## Migration Notes

The following files were renamed to follow these conventions:

- `requestTransformer.ts` → `request-transformer.ts`
- `collectionTransformer.ts` → `collection-transformer.ts`
- `runReportTransformer.ts` → `run-report-transformer.ts`
- `globalsTransformer.ts` → `globals-transformer.ts`
- `errorHandler.ts` → `error-handler.ts`
- `errorLogger.ts` → `error-logger.ts`

## Enforcement

When creating new files, ensure they follow these conventions. The TypeScript compiler will catch import errors if files are renamed, helping maintain consistency.

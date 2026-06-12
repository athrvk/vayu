# Task 9a — Divider grip visibility and split ratio persistence

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

Two related improvements to the request/response split panel:

1. The `ResizableHandle` already supports a `withHandle` prop that shows grip
   dots. Currently it may not be enabled in `RequestBuilderLayout.tsx`.

2. The split ratio should be persisted across sessions. The ratio is stored in
   `useLayoutStore().requestSplitRatio` (task 4a). This task wires the panel
   to read/write that value.

**Prerequisite**: Task 4a (layout-store) must be done first.

## File to change

**File**: `app/src/modules/request-builder/components/RequestBuilderLayout.tsx`
(verify the exact path — it may be `app/src/modules/request-builder/RequestBuilderLayout.tsx`
or similar; grep for `ResizablePanelGroup` to find it)

## What to change

### 1. Enable the grip dots

Find the `<ResizableHandle>` usage. If it doesn't have `withHandle`, add it:

```tsx
<ResizableHandle withHandle />
```

### 2. Read the persisted split ratio on mount

```tsx
const { requestSplitRatio, setRequestSplitRatio } = useLayoutStore();
```

The `ResizablePanelGroup` from `react-resizable-panels` (or whatever library
is used — check `package.json`) likely uses a ref or `onLayout` callback.
Use `onLayout` to persist changes:

```tsx
<ResizablePanelGroup
  direction="horizontal"
  onLayout={(sizes: number[]) => {
    if (sizes[0] !== undefined) {
      setRequestSplitRatio(sizes[0] / 100); // onLayout gives percentages
    }
  }}
>
  <ResizablePanel defaultSize={requestSplitRatio * 100} minSize={20} maxSize={80}>
    {/* Request pane */}
  </ResizablePanel>
  <ResizableHandle withHandle />
  <ResizablePanel defaultSize={(1 - requestSplitRatio) * 100} minSize={20} maxSize={80}>
    {/* Response pane */}
  </ResizablePanel>
</ResizablePanelGroup>
```

**Important**: read the actual file before editing to understand the current
panel API and avoid breaking the min/max size constraints or existing layout.

### 3. Debounce the store write

`onLayout` fires on every pixel. Debounce the `setRequestSplitRatio` call
with 200ms to avoid hammering the store:

```tsx
const debouncedSetRatio = useCallback(
  debounce((ratio: number) => setRequestSplitRatio(ratio), 200),
  [setRequestSplitRatio]
);
```

Check if `lodash/debounce` or a similar utility is already used in the project.
If not, implement a simple local debounce with `useRef<NodeJS.Timeout>`.

## Acceptance criteria

- The resize handle shows grip dots on hover (`withHandle` enabled).
- After resizing and refreshing the app, the split ratio is restored.
- `pnpm type-check` passes.
- `pnpm lint` passes.

## Files to touch

- `app/src/modules/request-builder/components/RequestBuilderLayout.tsx`
  (or wherever `ResizablePanelGroup` is used for the request/response split)

# Task 1c — Wire Electron `before-quit` to `flushAll()`

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

After task 1b adds `flushAll()` to the save store, the Electron main process
needs to call it before the app quits so in-flight edits are not lost.

The challenge: `flushAll()` lives in the renderer process (React/Zustand),
but `before-quit` fires in the main process. The bridge is IPC.

The existing preload at `app/electron/preload.js` already exposes an
`electronAPI` object on `window`. We need to add a new channel.

## What to change

### 1. `app/electron/preload.js`

Find the `contextBridge.exposeInMainWorld('electronAPI', { ... })` call.
Add a new entry that lets the renderer register a flush callback:

```js
onBeforeQuit: (callback) => {
  ipcRenderer.on('before-quit', (_event) => callback());
},
```

### 2. `app/electron/main.ts`

Find the `app.on('before-quit', ...)` handler (or add one if absent).
Before actually quitting, send the IPC message to the renderer and wait
briefly for it to finish:

```ts
app.on('before-quit', (event) => {
  // Give the renderer ~2s to flush pending saves before we quit
  if (!flushSent) {
    flushSent = true;
    event.preventDefault();
    mainWindow?.webContents.send('before-quit');
    setTimeout(() => app.quit(), 2000);
  }
});
```

Add `let flushSent = false;` near the top of the file (module scope, reset
if the window is recreated).

### 3. `app/src/App.tsx` (or the top-level shell component)

Register the IPC listener on mount and call `flushAll()`:

```ts
useEffect(() => {
  const api = (window as Window & { electronAPI?: { onBeforeQuit?: (cb: () => void) => void } }).electronAPI;
  if (!api?.onBeforeQuit) return;

  api.onBeforeQuit(async () => {
    await useSaveStore.getState().flushAll();
  });
}, []);
```

Import `useSaveStore` from `@/stores/save-store`.

## Acceptance criteria

- `pnpm type-check` passes.
- No new ESLint errors.
- The listener is registered once on mount (not on every render).

## Files to touch

- `app/electron/preload.js`
- `app/electron/main.ts`
- `app/src/App.tsx`

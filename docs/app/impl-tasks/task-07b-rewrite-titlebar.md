# Task 7b — Rewrite `TitleBar.tsx` with tabs + OS variants

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

**Prerequisites**: Task 3b (TabStrip), 3a (tabs-store), 7a (electron main.ts
fixes) should be done first.

`app/src/components/layout/TitleBar.tsx` currently renders:
- macOS: spacer (70px) for traffic lights, logo, no custom buttons
- Windows/Linux: logo, custom HTML min/max/close buttons

The redesign adds:
- `TabStrip` embedded in the title bar (between logo and right controls)
- Logo visible on **all** platforms
- Env switcher pill on the right
- Correct drag regions
- Bar height fixed at 38px (matching `TITLE_BAR_HEIGHT` from task 7a)

## What to change

**File**: `app/src/components/layout/TitleBar.tsx`

### Bar height

Change `h-8` (32px) to `h-[38px]` everywhere it appears. This is the one
constant that must match `electron/main.ts`.

### Layout structure

```tsx
const isMac = window.electronAPI?.platform === "darwin"
  ?? navigator.userAgent.includes("Mac");
const isWindows = window.electronAPI?.platform === "win32";

return (
  <div
    className="flex items-center h-[38px] bg-panel border-b border-border shrink-0 select-none"
    style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
  >
    {/* macOS: traffic light inset (~80px) */}
    {isMac && <div className="w-20 shrink-0" />}

    {/* Logo — visible on all platforms */}
    <div
      className="flex items-center px-3 shrink-0"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <img src="/logo.svg" alt="Vayu" className="h-5 w-5" />
    </div>

    {/* Tab strip — fills remaining space */}
    <div
      className="flex-1 flex overflow-hidden h-full"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <TabStrip />
    </div>

    {/* Right controls */}
    <div
      className="flex items-center gap-2 px-3 shrink-0"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <EnvPill />
      {/* Windows/Linux: custom window controls (macOS uses native) */}
      {!isMac && <WindowControls />}
    </div>
  </div>
);
```

### `<WindowControls />` (for Linux only — Windows uses native overlay)

```tsx
function WindowControls() {
  const minimize = () => window.electronAPI?.minimize?.();
  const maximize = () => window.electronAPI?.maximize?.();
  const close = () => window.electronAPI?.close?.();

  return (
    <div className="flex items-center gap-1 ml-2">
      <button onClick={minimize} className="w-3 h-3 rounded-full bg-yellow-400 hover:bg-yellow-500" />
      <button onClick={maximize} className="w-3 h-3 rounded-full bg-green-400 hover:bg-green-500" />
      <button onClick={close}    className="w-3 h-3 rounded-full bg-red-400 hover:bg-red-500" />
    </div>
  );
}
```

Check `app/electron/preload.js` to see what IPC methods are actually exposed
for minimize/maximize/close and use the correct names.

For Windows, the native overlay buttons are rendered by the OS — do NOT also
render HTML buttons for Windows. Only render `<WindowControls />` for Linux.

### `<EnvPill />`

Look for an existing env switcher component (check `app/src/modules/` or
`app/src/components/`). If it exists, import and use it. If not, render a
simple placeholder:

```tsx
function EnvPill() {
  const { activeEnvironmentId } = useSessionStore();
  // ... render a small badge showing the active env name
}
```

## Acceptance criteria

- Bar height is `h-[38px]`.
- Logo is visible on all three platforms.
- `TabStrip` is embedded and fills the available width.
- Windows: no HTML custom buttons (native overlay handles it).
- Linux: HTML custom buttons are shown.
- macOS: 80px left inset for traffic lights, no custom buttons.
- `WebkitAppRegion: "drag"` on the bar, `"no-drag"` on all interactive elements.
- `pnpm type-check` passes, `pnpm lint` passes.

## Files to touch

- `app/src/components/layout/TitleBar.tsx`

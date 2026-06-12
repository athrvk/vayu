# Task 7a — Fix `electron/main.ts` title bar configuration

## Context

Repository: `athrvk/vayu`. Work on branch `claude/clever-sagan-b4oTu`.

`app/electron/main.ts` has two bugs in its title bar setup:

1. `titleBarOverlay` is configured for **both** Windows and Linux. Linux DEs
   have inconsistent overlay support — it should be Windows-only.
2. The overlay `height` is 40px but the actual HTML bar is `h-8` = 32px.
   The redesign sets bar height to **38px** — both must match.
3. The overlay colors are hardcoded (`#1a1a1a` / `#ffffff`) and don't match
   the design token values (`#111113` dark / `#f2f0eb` light).

## What to change

**File**: `app/electron/main.ts`

### 1. Define the bar height constant

Near the top of the file (after imports, before window creation):

```ts
const TITLE_BAR_HEIGHT = 38; // px — must match TitleBar.tsx h-[38px]
```

### 2. Fix `BrowserWindow` options

Current (wrong):
```ts
titleBarStyle: "hidden",
titleBarOverlay: { color: "#1a1a1a", symbolColor: "#ffffff", height: 40 },
trafficLightPosition: { x: 12, y: 10 },
```

Replace with platform-conditional logic. Read `process.platform` at the
`BrowserWindow` creation site:

```ts
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

mainWindow = new BrowserWindow({
  // ... existing options ...
  frame: false,
  titleBarStyle: "hidden",
  trafficLightPosition: isMac ? { x: 12, y: (TITLE_BAR_HEIGHT - 16) / 2 } : undefined,
  titleBarOverlay: isWindows
    ? { color: nativeTheme.shouldUseDarkColors ? "#111113" : "#f2f0eb",
        symbolColor: nativeTheme.shouldUseDarkColors ? "#f2f0eb" : "#111113",
        height: TITLE_BAR_HEIGHT }
    : false,
  // ...
});
```

### 3. Update overlay color on theme change

Find the existing `nativeTheme.on("updated", ...)` handler (or add one):

```ts
nativeTheme.on("updated", () => {
  if (process.platform === "win32" && mainWindow) {
    mainWindow.setTitleBarOverlay({
      color: nativeTheme.shouldUseDarkColors ? "#111113" : "#f2f0eb",
      symbolColor: nativeTheme.shouldUseDarkColors ? "#f2f0eb" : "#111113",
      height: TITLE_BAR_HEIGHT,
    });
  }
});
```

### 4. Export the constant for use in `TitleBar.tsx`

Add to `app/electron/preload.js` (or use a shared constants file):

```js
// In preload.js, expose platform info if not already available
platform: process.platform,
titleBarHeight: 38,
```

Alternatively, just hardcode 38 in `TitleBar.tsx` too — as long as both
files use the same value. Comment: `// must match TITLE_BAR_HEIGHT in main.ts`.

## Acceptance criteria

- On Windows: `titleBarOverlay` is active with `height: 38`.
- On Linux: `titleBarOverlay: false` (custom HTML buttons remain).
- On macOS: no overlay, traffic lights positioned at `y = (38 - 16) / 2 = 11`.
- Colors derive from `nativeTheme.shouldUseDarkColors`.
- `pnpm type-check` passes.

## Files to touch

- `app/electron/main.ts`
- `app/electron/preload.js` (optional, only if you expose platform/height)

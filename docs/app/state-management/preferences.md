---
description: >-
  The cross-cutting Zustand stores for the active sub-tab per entity, the pre-paint interface preferences, the theme and the renderer's settings.
---

# Tab selection, appearance, theme and client settings stores

## `tab-selection-store.ts` - Active Sub-Tab And Open Element Rows Per Entity

Four independent maps remembering per entity id which sub-tab is showing (the request builder's tab, the response pane's tab, the collection screen's tab) and which `ElementList` rows are expanded.

**State:**
```typescript
{
  requestTab: Map<string, RequestTab>       // keyed by request id
  responseTab: Map<string, ResponseTab>     // keyed by request id
  collectionTab: Map<string, CollectionTab> // keyed by collection id
  openElementRows: Map<string, ReadonlySet<string>> // request or collection id -> expanded element ids
}
```

**Key Methods:**
```typescript
const { getRequestTab, setRequestTab } = useTabSelectionStore();
const { getResponseTab, setResponseTab } = useTabSelectionStore();
const { getCollectionTab, setCollectionTab } = useTabSelectionStore();
const { getOpenElementRows, setElementRowOpen } = useTabSelectionStore();
useTabSelectionStore.getState().clearEntity(id); // drops id from all four maps
useTabSelectionStore.getState().clearAll();
```

`setElementRowOpen(entityId, elementId, open)` replaces the entity's set with a copy (a subscriber holds it by reference) and is a no-op when the row is already in that state.
`ElementsPanel` and the collection's `ElementsTab` read the set by selector through `useOpenElementRows` and hand it to `ElementList` as `openIds`; a host with no entity id passes nothing and the list keeps local state.

**Why a store at all.**
`Shell.tsx` mounts one workspace tab's surface at a time, so `RequestBuilderProvider`, `ResponseViewer`, `CollectionDetail` and the `ElementList` rows inside the Elements tabs all unmount whenever the user looks at a different tab and remount when they come back - and each held its active sub-tab in a bare `useState`, which is gone the moment the component is.
The same three components also serve *every* open tab of their own type without remounting (`RequestBuilder` is not recreated per request tab, nor `CollectionDetail` per collection tab), so a tab-id change reaching the same component instance needed the same lookup a mount-time initializer already had to do -
both call sites read and write through this store rather than through two different mechanisms.

**In memory only, like `response-store.ts` above**, and for the same reason: a sub-tab pick, or which cards are open, is not worth persisting across a relaunch (a persisted set would also carry ids of elements deleted in an earlier session).
Unlike that store, this one carries no LRU cap - an entry is one enum value or a handful of element ids rather than a response body, so bounding it buys nothing.

**Eviction by identity:** `clearEntity` runs from `tabs-store`'s `closeTabsForEntities`, unconditionally rather than gated on `type` the way the response clear is - a collection id keys `collectionTab` exactly as a request id keys `requestTab` / `responseTab`, so a collection cascade has to evict here too, and `clearEntity` is a harmless no-op for whichever of the four maps never held a given id.

## `appearance-store.ts` - Pre-Paint Interface Preferences

The UI font, the interface scale, the corner roundedness and the interface density - the four preferences `index.html`'s pre-paint script applies before React mounts.
Seeded from localStorage at module load and written back one key per preference (`vayu-ui-font`, `vayu-ui-font-custom`, `vayu-ui-scale`, `vayu-ui-radius`, `vayu-ui-density`), *not* through zustand's `persist`: the pre-paint script reads those exact keys, and `SETTINGS_STORAGE_KEYS` clears them on "Reset app settings".

Density (issue #1670) differs from the other three in mechanism:
font, scale and radius each resolve a stored value to something `applyX` computes and writes with `style.setProperty`, while `applyDensity` only toggles a `data-density` attribute on `documentElement` - the two densities are whole `--spacing` values declared directly in `index.css` (`:root` / `[data-density="comfortable"]`), so there is nothing to compute.

**State:**
```typescript
{
  font: UiFontChoice   // a preset or "custom"
  fontCustom: string   // used when font === "custom"
  scale: number        // page-zoom factor, 0.8-2.0 in 0.1 steps
  radius: UiRadius
}
```

Each action both persists and applies (`--font-sans`, `--radius`, `webFrame.setZoomFactor`), so there is one write path per preference rather than a state update and a separate effect that has to agree with it.

**Why a store and not `useState` in `useAppearance`:** scale has two inputs.
The Appearance panel's slider and the View menu's `Ctrl`/`Cmd` `+` `-` `0` move the same value, and `useAppearance` is mounted twice (the app shell and the panel).
Per-instance state let the panel keep reading "Default" while the window rendered 133%.
The menu bridge (`onZoomCommand` → `nudgeScale`/`resetScale`) lives in `useMenuActions`, which mounts exactly once - subscribing from `useAppearance` would move the zoom two steps per keypress.

The scale range, the legacy-preset migration and the clamp/snap live in `constants/appearance.ts` (`clampScale`, `parseScale`, `nudgeScale`).
The pre-paint script duplicates them by necessity - it runs before any module - and `appearance.prepaint.test.ts` executes the real script to keep the duplicate honest.

## `theme-store.ts` - Light/Dark Mode and Accent Scheme

The theme source (`system` / `light` / `dark`), the manual accent colour scheme, the last accent the OS reported and the "match system accent" preference, with `isDark`, `supportsAccent` and `isLoading`.
Like `appearance-store.ts` it is written one localStorage key per preference by the action (`vayu-theme-source`, `vayu-color-scheme`, `vayu-match-system-accent`, `vayu-system-accent`), not through zustand's `persist`: the pre-paint script in `index.html` reads all four, and `SETTINGS_STORAGE_KEYS` clears all four on "Reset app settings".

**State:**
```typescript
{
  themeSource: ThemeSource      // "system" | "light" | "dark"
  colorScheme: ColorScheme      // the manual pick; the OS accent never overwrites it
  systemAccent: ColorScheme | null  // last scheme the OS reported; null until one has
  isDark: boolean
  isLoading: boolean            // until the first persisted + OS read lands
  matchSystemAccent: boolean
  supportsAccent: boolean       // Windows/macOS only; Linux resolves no OS accent
}
```

**Two accent fields (#1861).**
The scheme on screen is derived, not stored: `effectiveColorScheme(state)` is `systemAccent` while `matchSystemAccent` is on and the OS has reported one, `colorScheme` otherwise.
Turning matching on fetches the OS accent into `systemAccent` and never calls `setColorScheme`, so `vayu-color-scheme` keeps the user's pick and turning matching off returns to it.
Every OS accent report, at launch or live through `onAccentSchemeChanged`, is written to `vayu-system-accent` whether or not matching is on, so a later toggle starts from the current accent and the pre-paint script can paint it.
The pre-paint script applies the same rule to the stored keys: the system accent when `vayu-match-system-accent` is `"true"` and the accent key is set, `vayu-color-scheme` otherwise.
`useElectronTheme` returns both `colorScheme` (the manual pick, what the tile grid writes) and `effectiveColorScheme` (what is painted, what the Appearance panel displays while matching).

**One DOM writer.**
Every action and every OS event updates the store and then calls `writeDocument` with the store's own state (`dark` class and `data-color-scheme` on `<html>`, the latter from `effectiveColorScheme`).
Nothing passes it a value of its own, so the document cannot be set from a copy.

**Why a store and not `useState` in `useElectronTheme` (#1855):** the hook is mounted three times - the app shell, the Appearance panel and the command palette (`useCommandSurfaces`).
With per-instance state each held the scheme it read at mount and re-applied it on every `theme:changed` broadcast (an OS light/dark flip, or any `setTheme` round trip), so an instance that had not seen the panel's pick wrote the stale scheme over it, and the palette's "Toggle theme" decided its direction from an `isDark` only its own `setTheme` updated.
The same rule as `appearance-store.ts` above: state that more than one mounted consumer reads or writes belongs in a store.

**Subscriptions are reference-counted.**
`useElectronTheme` calls `attach()` in an effect and releases on unmount; the first holder reads the persisted and OS state and registers `onThemeChanged` / `onAccentSchemeChanged` (or the `prefers-color-scheme` listener outside Electron), and the last to release removes them.
Three hook instances therefore share one set of listeners, and no consumer has to know which mount is "the" mount.
Listeners are registered after the first read, so an event cannot apply the default scheme over the one the pre-paint script chose.

## `client-settings-store.ts` - Renderer Preferences

Central home for renderer-only preferences that aren't part of the pre-paint appearance set (theme/color/UI-font/scale/radius live in their own localStorage keys so `index.html` can apply them before React mounts).
Holds editor behavior, the monospace/code font, chart granularity, the p99 threshold, the live refresh rate, auto-save preferences, reduced motion, the notification preferences and the load-test dialog's ceilings.
Backs the Settings **panels** (`modules/settings/main/panels/`).
Non-React consumers (services, the dashboard store) read via `getState()`.

**State:**
```typescript
{
  editor: EditorPrefs            // fontSize, wordWrap, minimap, lineNumbers, tabSize
  monoFont: MonoFontChoice       // a preset or "custom"
  monoFontCustom: string         // used when monoFont === "custom"
  chartBucketSeconds: number     // time-bucket width for the dashboard charts
  sloThresholdMs: number         // p99 latency the breakpoint is judged against, for every mode but capacity (a capacity run uses its own sloMs); never the line the charts draw (that is the run's own, `runOwnSloMs`)
  liveRefreshMs: number          // how often live metrics commit into the store
  autoSave: AutoSavePrefs        // { enabled, delayMs }
  reducedMotion: boolean         // mirrored onto <html data-reduced-motion>
  keepAwakeDuringRuns: boolean   // standing answer on the run wake lock; default off
  systemNotifications: boolean   // opt-in for OS notifications while Vayu is in the background; default off
  notifications: NotificationPrefs  // position, durationScale, maxVisible, minSeverity
  loadTestCeilings: LoadTestCeilings
  approvedEndpoints: string[]    // origins the user has contacted; the GraphQL schema loads on its own only for these
}
```

```typescript
import { SETTINGS_STORAGE_KEYS } from "@/stores";  // localStorage keys reset by "Reset app settings"
```

`monoFont` and `reducedMotion` also touch the DOM (`--font-mono`, `data-reduced-motion`), so their setters and `onRehydrateStorage` both apply them - a preference that only lands on the next reload reads as a broken setting.

**Start at login is not a field here** (issue #2098).
The login item lives in the OS - the user can remove it from Task Manager, System Settings or a desktop's startup list without Vayu knowing - so `StartAtLoginCard` reads it through `electronAPI.getLoginItem()` on mount and after each `setLoginItem()`, and nothing joins `SETTINGS_STORAGE_KEYS`.
`resetAll` is the one place the store touches it: it calls `setLoginItem(false)` before it clears the keys and reloads, so a reset to defaults does not leave Vayu starting at login.

`keepAwakeDuringRuns` is the user's standing answer to whether a run may ask the OS to stay awake (issue #1357).
It is **read when a run starts** rather than watched, by `LoadTestService` and `ScenarioRunService`, so the answer that governs a run is the one that was true when it began - flipping the row mid-run does not reach a stream already going.
Off is the shipped default: with it off a load run of ten minutes or more asks once (`KeepAwakePrompt`), and that grant takes the same wake-lock key the service releases, so it ends with the run.

`systemNotifications` is the opt-in for the OS notifications `services/notify.ts` posts (issue #1358).
It is **read at the moment an event fires**, not watched, by the same reasoning as `keepAwakeDuringRuns`: every call site is a service or an event handler with no hook to hang a subscription on.
Off is the shipped default, and it is persisted through `partialize` like the rest of this store's top-level preferences.

`loadTestCeilings` is the one slice with a bound outside the app: each value is clamped to `LOAD_TEST_CEILING_BOUNDS` (`constants/load-test.ts`) on write **and** on rehydrate, because the bounds are the engine's crash guards and a build that tightens one must not keep offering a stored ceiling above it.
The load dialog turns them into its field ranges via `resolveLoadTestLimits`; nothing else reads them.

`approvedEndpoints` is the list of origins (scheme, host, port) the user has chosen to contact: `useEngine().composeRequest` adds the composed URL's origin on every Send, Load test and History re-run, and a manual schema load adds the one it reached (`lib/graphql/approved-endpoints.ts`).
The GraphQL body's automatic introspection reads it and nothing else does.
It is a list of strings, not an object, so the rehydrate merge filters it to strings rather than completing it.

**Persisted** to localStorage (via `zustand/persist`), `version: 1` with a pass-through `migrate`; workspace/session state (open tabs, layout, active environment) is deliberately excluded from the reset, as is the live chart window - that one is engine config, so it resets with the engine's settings.

**Nested preferences are completed against their defaults on rehydrate** (`mergeWithNestedDefaults`). zustand's merge is a shallow top-level spread, so a stored `editor` / `autoSave` / `notifications` / `loadTestCeilings` object replaces its defaults whole and a key added after that payload was written arrives `undefined` -
`notifications.maxVisible` feeds `slice(-maxVisible)` in `toast-store`, and `slice(-undefined)` caps nothing.
Adding an object-valued preference means adding a line to that merge; the store's test enumerates them rather than trusting the list.

**Closed-list pickers snap on rehydrate.**
A stored `autoSave.delayMs`, `chartBucketSeconds` or `liveRefreshMs` outside its option list (a retired option, a hand-edited payload) is snapped in `onRehydrateStorage` - to the nearest option for the delay, to the default for the other two - because `migrate` runs only on a version mismatch and would miss a same-version payload.

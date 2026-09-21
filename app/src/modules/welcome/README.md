# Welcome Module

**Location:** Main content area only

Vayu's new-tab surface. Rendered for the `welcome` tab (opened by TabStrip's
`+`), when no tab is open at all, and for a request tab with no entity.

## What this screen is for

It is **not** a resume screen. `openTabs` and `activeTabId` are persisted and
restored, so a returning user lands back on the exact tabs they left. This
screen's job is to **start something new**.

Two consequences worth keeping in mind before adding anything here:

- **No marketing content.** A "Key Features" grid and two hardcoded performance
  numbers were removed because they pitch software the user has already
  installed, and the static numbers read as if they were telemetry.
- **No duplicates.** Anything already visible in the Collections sidebar or the
  History drawer does not belong here - a "Recent Collections" list was removed
  for repeating the sidebar rendered beside it.

## Structure

- `WelcomeScreen.tsx` - container: queries, `handleNewRequest`, state selection
- `FirstRunWelcome.tsx` - fresh workspace; import leads, and this is the only
  state that carries branding
- `Launcher.tsx` - populated workspace; actions, recent runs, counts
- `components/ActionTile.tsx`, `components/DemoApiTile.tsx`,
  `components/RecentRuns.tsx`, `components/FooterLinks.tsx`
- `demo-request.ts` - the request `DemoApiTile` creates
- `welcome-column.ts` - the one class string the three states share

## Notes

- Both queries return `[]` while loading, so the container holds on `isLoading`.
  Without that the first-run screen flashes at every returning user.
- `RecentRuns` copies before sorting - the array is the TanStack Query cache.
- Doc links use `window.electronAPI.openAppLink(key)`, a keyed IPC channel. The
  renderer cannot open arbitrary URLs, and a plain `<a target="_blank">` would
  spawn an unmanaged Electron window.
- **The column is the state's own, not the container's** (`welcome-column.ts`,
  #1691). The screen used to fill the tab, so at 1440px the tiles and the recent
  runs hugged the left edge with the right two-thirds empty. `WelcomeScreen`'s
  scroller contributes gutters only and each state carries `WELCOME_COLUMN`; a
  skeleton in a different column from the content it stands in for would shift
  the page the moment the queries land, which is what the skeleton exists to
  prevent. `max-w-2xl` is the widest size on the dialog scale, for the same
  reason that size exists: a surface whose work is reading and choosing.
- Styling follows `docs/design-system.md` - 11px eyebrows, 13px body, mono
  tabular numerals, `rounded-md`. No `text-5xl`/`text-xl`, no gradients.
- **The Launcher's "Open Demo API" tile is a second first-run step, decided in
  issue #1694**: the Launcher is the end state (no separate screen beyond it),
  it is a tile rather than a strip, and it retires the moment a run exists
  (`Launcher.tsx` renders `DemoApiTile` only while `runs.length === 0`) - no
  dismiss of its own, since the question it asks is answered by then. It opens
  a real, pre-filled request (`demo-request.ts`) through the same
  `useNewRequest` targeting every other "New request" entry point uses, so it
  never disagrees with them about where the request lands.

## Usage

```tsx
import WelcomeScreen from "@/modules/welcome/WelcomeScreen";
```

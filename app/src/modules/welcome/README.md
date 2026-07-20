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
  History drawer does not belong here — a "Recent Collections" list was removed
  for repeating the sidebar rendered beside it.

## Structure

- `WelcomeScreen.tsx` — container: queries, `handleNewRequest`, state selection
- `EmptyState.tsx` — fresh workspace; import leads, and this is the only state
  that carries branding
- `Launcher.tsx` — populated workspace; actions, recent runs, counts
- `components/ActionTile.tsx`, `components/RecentRuns.tsx`,
  `components/FooterLinks.tsx`

## Notes

- Both queries return `[]` while loading, so the container holds on `isLoading`.
  Without that the first-run screen flashes at every returning user.
- `RecentRuns` copies before sorting — the array is the TanStack Query cache.
- Doc links use `window.electronAPI.openAppLink(key)`, a keyed IPC channel. The
  renderer cannot open arbitrary URLs, and a plain `<a target="_blank">` would
  spawn an unmanaged Electron window.
- Styling follows `docs/design-system.md` — 11px eyebrows, 13px body, mono
  tabular numerals, `rounded-md`. No `text-5xl`/`text-xl`, no gradients.

## Usage

```tsx
import WelcomeScreen from "@/modules/welcome/WelcomeScreen";
```

---
description: >-
  The cross-cutting Zustand stores for update verification, inbox notifications, the import modal and report, the environment menu, OAuth sign-in and toasts.
---

# Notice, menu and modal stores

## `update-verification-store.ts` - An Installer That Would Not Verify

The downloaded update whose build-provenance attestation did not verify (issue #2372), or `null`.

**State:**
```typescript
{
  failure: { version: string; reason: string } | null
  setFailure: (failure) => void
  clear: () => void
}
```

**Non-persisted.**
`useAppUpdate` writes it from every download state it receives (`update:state`, and `getUpdateState()` on mount, so a reload keeps it): `refused` sets it and any other state clears it.
It is a store rather than hook state because the banner receives the state for the whole session while `UpdatesCard` mounts only when Settings opens, and a per-instance hook would show it nothing.
Both read it with a selector.

## `inbox-notify-store.ts` - Which Inboxes May Notify On A Capture

Whether a capture landing on one inbox may raise an OS notification while Vayu is in the background (issue #1388), keyed by inbox id.
Off for an inbox nobody has decided about, and off even when `systemNotifications` is on: a capture is the one relevant event with no natural rate, and a webhook source that retries would otherwise teach the user to turn the whole feature off, taking the run-finished notification with it.

It lives here rather than on the engine's inbox record, the way `host-sleep-store` keeps a run's annotation beside a report with no field for it: the engine's inbox is in-memory state that never outlives the process that opened it, and it does not act on this flag - only the desktop app does.

**State:**

```typescript
{
  enabled: Record<string, true>  // only the inboxes that are on; off is absence
}
```

Four readers.
Two at the moment a capture arrives: `modules/inbox/capture-notifier.ts` gates on it (the second gate; `services/notify.ts` reads the global opt-in), and the header toggle in `modules/inbox/index.tsx` writes it.
The third is `hooks/useInboxWatchers.ts`, which reads the whole map continuously to decide which inboxes `services/inbox-watch-service.ts` should hold a live stream for: the toggle promises a notification while Vayu is in the background, and the inbox tab is mounted only while it is the active tab (issue #1400).
The fourth is the Services drawer's inbox row (`modules/services/ServicesPanel.tsx`), which reads one inbox's entry to decide whether to say the promise is not currently being kept - a stream that gave up, or one the stream cap left out (issue #1412).
It reads rather than writes, and an inbox whose toggle is off gets no note, because there is nothing to say about a promise that was never made.

**Persisted**, and pruned: an inbox id belongs to the engine process that minted it, so `retainInboxes` drops every id a successful `GET /inbox` no longer names, called from `useInboxWatchers` on a list read the engine actually answered - a failed read leaves the map alone, because "no inboxes" and "could not ask" are not the same list.
It was called from `InboxView` until #1400, which pruned the map only while that tab happened to be open.
`migrate` and `merge` both normalize, as `host-sleep-store` does.

## `import-modal-store.ts` - Import Modal UI

Simple modal state for the collection import dialog.

**State:**
```typescript
{
  isOpen: boolean
}
```

**Key Methods:**
```typescript
const { isOpen, open, close } = useImportModalStore();
```

## `env-switcher-store.ts` - Title Bar Environment Menu

Whether the title bar's environment menu is open (issue #2115).
The menu is a Radix `DropdownMenu`, which owns its open state unless handed one; `TitleBar`'s `EnvSwitcher` binds `open` / `onOpenChange` to this store so a toast action raised elsewhere (the import's **Choose environment**) can open it.

**State:**
```typescript
{
  isOpen: boolean
  setOpen: (open: boolean) => void
}
```

**Non-persisted.**

## `import-report-store.ts` - What An Import Left Undone

The loss report of a successful import, kept after the dialog that showed it closes (issue #2109).
The preview lists everything an import dropped or altered, one line each (`importNotices`); on success the dialog resets and that list used to go with it.
`announceImport` (`modules/collections/import-report.ts`) records one `ImportReport` per applied file here, keyed by the **real** id of each root collection the file created, so a file that created several roots stores the same report under each.
`announceImport` also folds the outcome of the import's environment activation (`import-environment.ts`) into the toast it raises.

**State:**
```typescript
{
  reports: Record<string, ImportReport>   // by root collection id
}
// ImportReport: { title, fileName, notices, fileNeeds, counts, rootIds }
```

`fileNeeds` is `fileReferenceNeeds`' answer computed at apply time, not the drafts it was read from: those hold every request body and the spec document, and `FileReferenceNeedsView` (`ImportFileFolders.tsx`) draws the same list from the answer.
A report with nothing in it, or a file that created no collection, is not stored.

**Key Methods:**
```typescript
const report = useImportReportStore(selectImportReport(collectionId));
useImportReportStore.getState().dismiss(collectionId);  // drops the file's report from every root
```

**Non-persisted** (in memory, like `import-modal-store`): a report is about the import just made, and a reload has nothing to compare it with.

## `oauth-signin-store.ts` - Which Configs Are Signing In

The interactive OAuth 2.0 sign-in running per token cache key (#3354).
A sign-in belongs to the config rather than to the `TokenStatusRow` that started it: the Auth tab, the context bar and the collection editor can each show a row for one config, and they must share one pending state and one browser tab.
Modelled on `request-builder/context/send-tracker.ts`: the store holds only what renders, and the `AbortController`s and owner counts sit in module maps beside it.
The key is `oauth2SignInKey` (`services/oauth/discovery.ts`): the cache key, or `discover:<server URL>` for a config discovered from a server URL that no sign-in has filled yet (#3766), which has no cache key.
Every surface that starts a sign-in goes through `useOAuth2SignIn` (`components/shared/OAuth2Form/`), which acquires the key while it is mounted.

**State:**
```typescript
{
  active: ReadonlySet<string>   // cache keys with a sign-in running
}
```

**Key Methods:**
```typescript
oauthSignin.begin(key)             // AbortSignal, or null if one is already running
oauthSignin.end(key, signal)       // flow over; no-op for a signal that is no longer the key's
oauthSignin.cancel(key)            // abort and clear at once
const release = oauthSignin.acquire(key)  // a row showing the key; the last release cancels
useIsSigningIn(key)                // reactive; false for a null key
```

**Non-persisted.**
A sign-in cannot outlive the window that is waiting on it.

## `toast-store.ts` - Transient Notifications

The queue behind the toasts.
It holds *what* to show; the Radix primitive in `components/ui/toast.tsx` owns *when* - the dismiss timer, pausing on hover, focus and window blur, swipe, and the open/closed state the exit animation keys off.
There is no `setTimeout` in the store.

**State:**
```typescript
{
  toasts: Toast[]   // { id, title?, message, variant, action?, duration }
}
```

**Key Methods:**
```typescript
const { showToast, dismissToast } = useToastStore();

showToast("Run history cleared", "success");   // string form, still supported
showToast({                                     // returns the toast id
  message: "Couldn't stop the run",
  variant: "error",
  action: { label: "Try again", onClick: retry },
});
```

Variants are `info` | `success` | `warning` | `error`, with base durations of 4s / 4s / 6s / 10s from `TIMING.TOAST_DURATION_MS`.
`warning` is for a refusal ("A load test is already running.", `runningRunSentence`) as distinct from a failure.

**Three of the policies are user preferences** (`notifications` on `client-settings-store`, shapes in `constants/toast.ts`), applied here on the way in:

- `minSeverity` - a floor, compared by `passesSeverityFloor`.
  Below it `showToast` returns an id and shows nothing.
- `durationScale` - a **multiplier** over the per-variant duration (`scaledDuration`), not a replacement for it, so halving keeps the ratio between a confirmation and a failure.
  `never` becomes `NEVER_DISMISS_MS` rather than `Infinity`, which the primitive's `setTimeout` would coerce to 1.
- `maxVisible` - the stack cap, defaulting to `MAX_TOASTS` (4); past it the oldest is dropped.

Two more policies live here because the primitive has no opinion on them: an identical message and variant already on screen is **collapsed rather than stacked**, and an explicit `duration` from the caller wins over the scale.
Removal is driven by the primitive's `onOpenChange(false)`, which covers timeout, close button and swipe alike, so there is one removal path rather than three - but it *closes* the toast rather than dropping it, and the entry leaves the queue `TIMING.TOAST_EXIT_MS` later so the exit animation has frames to run in.

**The values are not in the store.**
Delays live in `config/timing.ts` (`TOAST_DURATION_MS`, `TOAST_EXIT_MS`) with every other UI-facing delay in the app, and the stack cap in `constants/toast.ts` (`MAX_TOASTS`).
The store holds behaviour, not configuration.

See `docs/design-system.md` -> Toasts for the visual tokens.

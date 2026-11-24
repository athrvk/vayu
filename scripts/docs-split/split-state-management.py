#!/usr/bin/env python3
"""
Splits docs/app/state-management.md into the pages of docs/app/state-management/
(#3854), re-aims every link to it, and proves the move lost nothing. The machinery
and what a move changes are in docsplit.py; this file holds where the sections go
and the new text (titles, descriptions, the index's table of pages).

Usage: split-state-management.py [--root DIR] [--rev REV] [--check | --verify | --render]
"""

import sys

from docsplit import Page, Split, main

# A section starts at a marker and runs to the next one. The stores keep their
# source order, so a page that holds stores from two places in the source has the
# earlier one first.
MARKERS = [
    ("---", "index"),
    ("#### `tabs-store.ts` - Open Tabs & Navigation", "tabs-layout-session"),
    ("#### `data-file-store.ts` - Where Each Collection's Data File Lives", "data-and-spec-files"),
    ("#### `engine-store.ts` - Engine Connection & Restart State", "engine-and-response"),
    ("#### `save-store.ts` - Centralized Auto-Save", "save-and-drafts"),
    ("#### `response-store.ts` - Response Cache", "engine-and-response"),
    ("#### `tab-selection-store.ts` - Active Sub-Tab And Open Element Rows Per Entity", "preferences"),
    ("#### `dashboard-store.ts` - Load Test Metrics & State", "run-live-state"),
    ("#### `update-verification-store.ts` - An Installer That Would Not Verify", "notices-and-menus"),
    ("#### `host-sleep-store.ts` - When The Machine Slept Under A Run", "run-live-state"),
    ("#### `inbox-notify-store.ts` - Which Inboxes May Notify On A Capture", "notices-and-menus"),
    ("#### `scenario-run-store.ts` - Live Collection-Run Steps", "run-live-state"),
    ("#### `import-modal-store.ts` - Import Modal UI", "notices-and-menus"),
    ("### Module-Local Stores", "module-local-stores"),
    ("## TanStack Query (Server State)", "query-hooks"),
    ("### Query Keys & Cache Invalidation", "query-keys"),
    ("## Custom Hooks", "engine-and-variable-hooks"),
    ("### `RequestBuilderContext` - variable members", "request-builder-context"),
    ("### `useSaveManager()` - Auto-Save Manager", "draft-hooks"),
    ("## State Flow Examples", "flows-and-practices"),
]

PAGES = {
    "index": Page(None, None),
    "tabs-layout-session": Page(
        "Tabs, layout and session stores",
        "The cross-cutting Zustand stores for open tabs and navigation, the drawer and panel layout, "
        "and the active environment.",
        ("`tabs-store.ts`, `layout-store.ts`, `session-store.ts`",),
    ),
    "data-and-spec-files": Page(
        "Data file, spec file, bound row and recovery notice stores",
        "The cross-cutting Zustand stores for where a collection's data and spec files live, the row an "
        "open builder is bound to, and which data-loss notice was already seen.",
        ("`data-file-store.ts`, `spec-file-store.ts`, `bound-row-store.ts`, `recovery-notice-store.ts`",),
    ),
    "engine-and-response": Page(
        "Engine, response and console stores",
        "The cross-cutting Zustand stores for the engine connection and restart state, the response "
        "cache and the session console's rows.",
        ("`engine-store.ts`, `response-store.ts`, `console-store.ts`",),
    ),
    "save-and-drafts": Page(
        "Save and entity draft stores",
        "The cross-cutting Zustand stores for centralized auto-save and for unsaved collection drafts "
        "that outlive their editor.",
        ("`save-store.ts`, `entity-draft-store.ts`",),
    ),
    "preferences": Page(
        "Tab selection, appearance, theme and client settings stores",
        "The cross-cutting Zustand stores for the active sub-tab per entity, the pre-paint interface "
        "preferences, the theme and the renderer's settings.",
        ("`tab-selection-store.ts`, `appearance-store.ts`, `theme-store.ts`, `client-settings-store.ts`",),
    ),
    "run-live-state": Page(
        "Dashboard and live run stores",
        "The cross-cutting Zustand stores for load-test metrics, host sleep under a run, live "
        "collection-run steps and live streaming-request events.",
        ("`dashboard-store.ts`, `host-sleep-store.ts`, `scenario-run-store.ts`, `execution-events-store.ts`",),
    ),
    "notices-and-menus": Page(
        "Notice, menu and modal stores",
        "The cross-cutting Zustand stores for update verification, inbox notifications, the import modal "
        "and report, the environment menu, OAuth sign-in and toasts.",
        ("`update-verification-store.ts`, `inbox-notify-store.ts`, `import-modal-store.ts`, "
         "`env-switcher-store.ts`, `import-report-store.ts`, `oauth-signin-store.ts`, `toast-store.ts`",),
    ),
    "module-local-stores": Page(
        None,
        "The Zustand stores that live inside one feature module: collections, history, variables, "
        "settings, logs and the GraphQL explorer.",
        ("`modules/*/*-store.ts`, `lib/graphql/*-store.ts`",),
    ),
    "query-hooks": Page(
        None,
        "TanStack Query as the source of truth for server state: the query hooks for collections, "
        "requests, environments, globals and runs.",
        ("Query hooks",),
    ),
    "query-keys": Page(
        None,
        "The query keys, how a write invalidates the cache and the cache policy in `config/cache.ts`.",
        ("Query keys, cache invalidation, cache policy",),
    ),
    "engine-and-variable-hooks": Page(
        None,
        "The custom hooks for composing, executing and stopping a request, for live metrics and for "
        "variable resolution.",
        ("`useEngine()`, live metrics streaming, `useVariableResolver()`",),
    ),
    "request-builder-context": Page(
        "RequestBuilderContext",
        "What `RequestBuilderContext` holds besides the request: variable members, body drafts, the "
        "GraphQL Variables draft, bulk edit drafts and the headers a setting added.",
        ("`RequestBuilderContext`",),
    ),
    "draft-hooks": Page(
        "Save and draft hooks",
        "The hooks for auto-save and manual drafts: `useSaveManager`, `useEntityDraft`, "
        "`useDraftSaveContext` and how the request builder's draft adopts an external write.",
        ("`useSaveManager()`, `useEntityDraft()`, `useDraftSaveContext()`, draft adoption",),
    ),
    "flows-and-practices": Page(
        "State flow examples and best practices",
        "Worked state flows - a single request, a load test run, an auto-save, variable resolution "
        "priority - and the practices for state code.",
        ("State flow examples, best practices",),
    ),
}

SPLIT = Split(
    source="docs/app/state-management.md",
    markers=MARKERS,
    pages=PAGES,
    table_columns=("Covers",),
    table_intro="Each page holds the stores or hooks of one part of the app's state.",
    table_before="## Architecture Overview",
    prog="split-state-management",
    label_prefix=r"(?:docs/)?(?:app/)?",
)

if __name__ == "__main__":
    sys.exit(main(SPLIT))

# Interaction Fidelity (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every interactive element in the app a visible keyboard focus ring and consistent hover motion, without touching ~20 files or risking core navigation.

**Architecture:** A zero-specificity baseline in `@layer base` of `app/src/index.css`, using `:where()` so any component utility overrides it without `!important`. Two clipping containers (Drawer content, TabStrip row) get a `.panel-clip` marker that tucks the ring inward for all descendants, current and future.

**Tech Stack:** Tailwind CSS v4 (`@layer base` / `@layer utilities`), React + TypeScript, Vitest + @testing-library/react + jest-dom.

## Global Constraints

- Colours come from CSS custom properties only. Never `bg-gray-*`, `text-zinc-*`, or hardcoded hex. Use `hsl(var(--ring))`, `hsl(var(--border))`, etc.
- Never Tailwind's unsuffixed `rounded` — it ignores the user-adjustable `--radius`. Use `rounded-sm` / `rounded-md` / `rounded-lg`.
- Do **not** add new dependencies. `@testing-library/user-event` is **not** installed; use native `.focus()` plus `document.activeElement` and `tabIndex` assertions.
- Transitions must list paint properties explicitly (`background-color`, `color`, `border-color`, `opacity`). Never `transition: all` — it can animate layout properties and cause reflow jank.
- The existing reduced-motion rule (`html[data-reduced-motion="true"]`, kept outside `@layer` so its `!important` wins) already collapses all transitions app-wide. Do not add per-rule reduced-motion guards.
- Interaction-state duration is **150ms**. Entrance animations stay **200ms** (`fade-in`, `slide-in`, accordion). These are different values on purpose.
- Existing `components/ui/*` primitives already carry `focus-visible:ring` utilities and must keep their current appearance. This work is additive.

---

### Task 1: Focus and transition baseline

**Files:**
- Modify: `app/src/index.css` (insert a new `@layer base` block immediately before the `/* Custom scrollbar */` comment and its `@layer components {` block, currently at line ~420)

**Interfaces:**
- Consumes: `--ring` (already defined per accent theme in `index.css`)
- Produces: a global `:focus-visible` outline and a paint-only transition on interactive elements. Task 2 relies on the `outline-offset: 2px` default being present so its `.panel-clip` rule has something to override.

**Why no unit test here:** jsdom does not apply `index.css`, so a test asserting `outline` styles would pass whether or not the CSS is correct — worse than no test. This task is verified by build plus manual inspection. Task 2 carries the automated tests.

- [ ] **Step 1: Add the baseline block**

Insert immediately before the `/* Custom scrollbar */` comment in `app/src/index.css`:

```css
/*
 * Interaction baseline.
 *
 * :where() keeps specificity at 0, so any component utility (utilities layer)
 * overrides these without !important. :focus-visible fires only on keyboard or
 * assistive-tech focus, never a mouse click, so pointer users see no change.
 *
 * outline (not box-shadow/ring) is deliberate: it does not participate in
 * layout, and modern browsers make it follow border-radius, so it tracks the
 * user-adjustable --radius for free.
 */
@layer base {
	:where(
			button,
			[role="button"],
			a[href],
			input,
			select,
			textarea,
			summary,
			[tabindex]:not([tabindex="-1"])
		):focus-visible {
		outline: 2px solid hsl(var(--ring));
		outline-offset: 2px;
	}

	/*
	 * Paint properties only — never layout, so this cannot cause reflow jank.
	 * 150ms is the interaction-state duration; entrances stay at 200ms.
	 * The reduced-motion rule below collapses this app-wide when enabled.
	 */
	:where(button, [role="button"], a[href], summary) {
		transition:
			background-color 150ms ease,
			color 150ms ease,
			border-color 150ms ease,
			opacity 150ms ease;
	}
}
```

- [ ] **Step 2: Add the inset escape hatch**

Append inside the **first** `@layer utilities` block in `app/src/index.css` (the one containing `.font-code`, currently starting at line ~444), after the `.variable-highlight` rule:

```css
	/* For focusable elements clipped by an ancestor's overflow, where an
	   outset ring would be cut off but the ancestor has no .panel-clip. */
	.focus-ring-inset:focus-visible {
		outline-offset: -2px;
	}
```

- [ ] **Step 3: Verify the build compiles the CSS**

Run: `cd app && pnpm build`
Expected: `✓ built in …`, no CSS syntax errors.

- [ ] **Step 4: Verify nothing regressed**

Run: `cd app && pnpm type-check && pnpm test`
Expected: type-check silent; all tests pass (447 at time of writing).

- [ ] **Step 5: Commit**

```bash
git add app/src/index.css
git commit -m "feat(ui): add keyboard focus ring and interaction transition baseline

Most interactive surfaces are hand-rolled <button> elements that never
picked up a focus ring — including TabStrip, Dock, CollectionTree and
TitleBar — so tabbing through the app showed no position. Hover motion
was inconsistent too: 11 of 42 files snapped while others eased.

Adds a zero-specificity :where() baseline in @layer base rather than
touching ~20 files, so new hand-rolled buttons inherit it and the drift
cannot return. Uses outline (follows border-radius, no layout impact)
over box-shadow, and lists paint properties explicitly so no layout
property can animate."
```

---

### Task 2: Inset the ring inside clipping containers

**Files:**
- Modify: `app/src/index.css` (append to the `@layer base` block added in Task 1)
- Modify: `app/src/components/layout/Drawer.tsx:44`
- Modify: `app/src/components/layout/TabStrip.tsx:154`
- Create: `app/src/components/layout/focus-containers.test.tsx`

**Interfaces:**
- Consumes: the `outline-offset: 2px` default from Task 1.
- Produces: a `.panel-clip` class contract — put it on the element that carries the `overflow-*`, and every focusable descendant gets `outline-offset: -2px`.

**Why these two elements:** TabStrip tabs are `<div role="tab" tabIndex={0}>` with `h-full` inside an `overflow-x-auto` row, so an outset ring clips top and bottom. Drawer rows are `w-full` buttons inside `overflow-hidden`, so an outset ring clips left and right.

- [ ] **Step 1: Write the failing test**

Create `app/src/components/layout/focus-containers.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabStrip } from "./TabStrip";
import { useTabsStore } from "@/stores";

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: undefined }),
	useCollectionsQuery: () => ({ data: [] }),
}));

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

function renderTabStrip() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<TabStrip />
		</QueryClientProvider>
	);
}

describe("focus containers", () => {
	beforeEach(() => {
		useTabsStore.setState({ openTabs: [], activeTabId: null });
	});

	// The tab row clips horizontally (overflow-x-auto) and tabs are h-full, so
	// an outset focus ring would be cut off. .panel-clip tucks it inward for
	// every focusable descendant — dropping it silently clips the ring.
	it("marks the tab row as a clipping panel", () => {
		renderTabStrip();
		expect(screen.getByRole("tablist")).toHaveClass("panel-clip");
	});

	it("keeps tabs reachable by keyboard and close controls out of tab order", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "welcome", entityId: null }],
			activeTabId: "t1",
		});
		renderTabStrip();

		const tab = screen.getByRole("tab");
		expect(tab).toHaveAttribute("tabindex", "0");
		tab.focus();
		expect(document.activeElement).toBe(tab);

		// Deliberate: a tab stop per close button makes tabbing noisy, and
		// Cmd/Ctrl+W already closes the active tab.
		expect(screen.getByLabelText("Close tab")).toHaveAttribute("tabindex", "-1");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/components/layout/focus-containers.test.tsx`
Expected: FAIL on the first test — `expect(element).toHaveClass("panel-clip")` reports the element has `flex h-full min-w-0 items-stretch overflow-x-auto` but not `panel-clip`.

- [ ] **Step 3: Add the `.panel-clip` rule**

Append inside the `@layer base` block added in Task 1, after the transition rule:

```css
	/*
	 * Rows inside a clipping panel: an outset ring is cut off by the ancestor's
	 * overflow, so tuck it inward. Put .panel-clip on the element carrying the
	 * overflow-* and every focusable descendant inherits this.
	 */
	:where(.panel-clip)
		:where(button, [role="button"], [tabindex]:not([tabindex="-1"])):focus-visible {
		outline-offset: -2px;
	}
```

- [ ] **Step 4: Mark the TabStrip row**

In `app/src/components/layout/TabStrip.tsx` line 154, change:

```tsx
			className="flex h-full min-w-0 items-stretch overflow-x-auto"
```

to:

```tsx
			className="panel-clip flex h-full min-w-0 items-stretch overflow-x-auto"
```

- [ ] **Step 5: Mark the Drawer content wrapper**

In `app/src/components/layout/Drawer.tsx` line 44, change:

```tsx
			<div className="flex-1 overflow-hidden flex flex-col min-w-0">
```

to:

```tsx
			<div className="panel-clip flex-1 overflow-hidden flex flex-col min-w-0">
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd app && npx vitest run src/components/layout/focus-containers.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 7: Run the full suite**

Run: `cd app && pnpm type-check && pnpm test`
Expected: type-check silent; all tests pass (449 expected — 447 plus the 2 new).

- [ ] **Step 8: Commit**

```bash
git add app/src/index.css app/src/components/layout/TabStrip.tsx app/src/components/layout/Drawer.tsx app/src/components/layout/focus-containers.test.tsx
git commit -m "feat(ui): inset the focus ring inside clipping panels

TabStrip tabs are h-full inside an overflow-x-auto row and Drawer rows
are w-full inside overflow-hidden, so an outset ring is clipped in both.
Scope the inset by container — .panel-clip on the element carrying the
overflow — rather than adding a class to every row component, so rows
added later inherit it automatically."
```

---

### Task 3: Document the conventions, verify, and remove the spec

**Files:**
- Modify: `docs/design-system.md` (the `## Animations` section, currently ~line 375, and a new subsection after it)
- Delete: `docs/superpowers/specs/2026-07-20-interaction-fidelity-design.md`

**Interfaces:**
- Consumes: the `.panel-clip` contract from Task 2 and the 150ms value from Task 1.
- Produces: nothing consumed by later tasks. This is the final task.

- [ ] **Step 1: Document the interaction-state duration**

In `docs/design-system.md`, in the `## Animations` table, add a row after the `slide-in` row:

```markdown
| interaction state | 0.15s | ease | *(baseline in `index.css`)* | Hover/active colour changes on interactive elements |
```

- [ ] **Step 2: Document the focus baseline**

Add this immediately after the "Live dot pattern" block at the end of `## Animations`:

```markdown
---

## Focus & Interaction States

Interactive elements get a keyboard focus ring and hover transition from a
baseline in `app/src/index.css` (`@layer base`) — **do not add per-component
focus classes for the default case.**

```css
:where(button, [role="button"], a[href], input, select, textarea, summary,
       [tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}
```

- `:where()` keeps specificity at **0**, so any component utility overrides it
  without `!important`. The `components/ui/*` primitives already carry their own
  `focus-visible:ring` and keep their appearance.
- `:focus-visible` fires only on keyboard/AT focus — mouse users never see a ring.
- `outline` (not `box-shadow`) follows `border-radius` automatically, so the ring
  tracks the user's roundedness setting.
- Transitions list paint properties explicitly (`background-color`, `color`,
  `border-color`, `opacity`) at **150ms**. Never `transition: all` — it can
  animate layout properties. Reduced motion already collapses these app-wide.

**Clipping panels.** An element whose `overflow-*` would cut off an outset ring
must carry `.panel-clip`; every focusable descendant then gets
`outline-offset: -2px`. Currently on the `TabStrip` row and the `Drawer` content
wrapper. Put it on the element carrying the overflow — not on the rows. For a
one-off outside such a container, use the `.focus-ring-inset` utility.
```

- [ ] **Step 3: Verify all gates pass**

Run: `cd app && pnpm type-check && pnpm test && pnpm build`
Expected: type-check silent; all tests pass; `✓ built in …`.

- [ ] **Step 4: Manual verification (requires a running app)**

Run: `cd app && pnpm run electron:dev`

Confirm each — automation cannot check these, because jsdom does not apply `index.css`:

- Tab through the app: a visible ring appears on TabStrip tabs, Drawer rows, and Dock buttons.
- The ring is **not clipped** on TabStrip tabs or Drawer rows.
- Clicking with the mouse shows **no** ring (confirms `:focus-visible`, not `:focus`).
- Check light **and** dark mode.
- Check at least two accent themes (Settings → Appearance → Color Scheme). `--ring` is theme-aware and must read well in more than the default.
- Settings → Appearance → Reduced Motion still collapses hover transitions.

- [ ] **Step 5: Delete the spec**

The spec was a working artifact; its durable rules now live in `design-system.md`.

```bash
git rm docs/superpowers/specs/2026-07-20-interaction-fidelity-design.md
```

Then confirm nothing references it:

Run: `grep -rn "2026-07-20-interaction-fidelity" --include="*.md" --include="*.tsx" --include="*.ts" . | grep -v node_modules`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add docs/design-system.md
git commit -m "docs(design-system): record focus ring and interaction timing

Documents the index.css interaction baseline so future components
inherit it instead of re-adding per-component focus classes, and records
150ms interaction-state timing as distinct from 200ms entrances.

Removes the phase-1 spec now that its durable rules live here."
```

---

## Notes for the implementer

- **Do not** add `focus-visible:` utilities to hand-rolled buttons as part of this work. The whole point is that the baseline covers them; per-component classes are what caused the drift.
- If a focus ring looks wrong on a specific component, first check whether an ancestor needs `.panel-clip` before adding a per-component override.
- The two files with hardcoded palette colours (`bg-zinc-900` etc.) are **out of scope** — a separate cleanup.

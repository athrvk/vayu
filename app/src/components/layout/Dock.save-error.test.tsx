/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A save failure should say why, for as long as it stays unsaved. The surface
 * has moved twice now.
 *
 * `save-store` used to record an `errorMessage` that nothing read, so the status
 * strip showed a bare "Save failed" for every cause. That was fixed by rendering
 * the reason in the Dock, then that line was removed in favour of a toast - one
 * channel for every failure in the app, with room for an engine message like
 * "database is locked" without truncating it into a `title` attribute.
 *
 * The toast turned out not to be the whole answer: it clears itself after ten
 * seconds, and a failed save can leave the draft unsaved for as long as the
 * engine stays down. Nothing said so once the toast was gone. The Dock now
 * carries a persistent "Not saved" line for exactly that gap, with the reason
 * back in a tooltip (`lastErrorMessage`) rather than truncated inline - so the
 * toast is still the first word on a failure, and the Dock is the standing one.
 *
 * What this file guards: `failSave` is what eight call sites reach, and it is
 * the only thing that turns them into both a toast and the Dock's line. If that
 * link breaks, every one of those failures goes unreported.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { TIMING } from "@/config/timing";
import { Dock } from "./Dock";
import { useSaveStore, useToastStore } from "@/stores";

// The Dock prints the app version, which Vite `define`s at build time; vitest
// does not, so without this the component throws before it renders anything.
vi.stubGlobal("__VAYU_VERSION__", "0.0.0-test");

/*
 * Rendered, not source-scanned. These cases used to grep `Dock.tsx` for
 * `saveStatus === "pending"` and friends, which stopped seeing anything the
 * moment the four gated spans became one width-reserved slot driven by a
 * lookup table - the same blind spot app/CLAUDE.md names for a class arriving
 * in a variable. What the user is owed is the line on screen, so that is what
 * these read.
 */
const renderDock = () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<Dock />
			</TooltipProvider>
		</QueryClientProvider>
	);
};

/** The slot's own text - nothing else lives inside it now. */
const liveSaveLine = () =>
	document.querySelector("[data-slot='dock-save-status']")?.textContent?.trim() ?? null;

beforeEach(() => {
	useSaveStore.setState({ status: "idle", lastErrorMessage: null });
	useToastStore.setState({ toasts: [] });
});

afterEach(cleanup);

describe("save failure reporting", () => {
	it("turns a failure into a toast carrying the reason", () => {
		useSaveStore.getState().failSave("database is locked");
		const [toast] = useToastStore.getState().toasts;
		expect(toast?.message).toBe("database is locked");
		expect(toast?.variant).toBe("error");
	});

	it("still records the status, which the Dock reads", () => {
		useSaveStore.getState().failSave("disk full");
		expect(useSaveStore.getState().status).toBe("error");
	});

	it("does not truncate an engine message the way the strip once had to", () => {
		// The removed surface was a 60-character span with the remainder hidden
		// in a `title`. Both the toast and the Dock's tooltip have room for the
		// whole thing.
		const long = "database is locked: attempt 3 of 3 failed after 5000ms, giving up";
		useSaveStore.getState().failSave(long);
		expect(useToastStore.getState().toasts[0]?.message).toBe(long);
		expect(useSaveStore.getState().lastErrorMessage).toBe(long);
	});

	it("renders a persistent Not saved line once the toast has expired", () => {
		// The gap the toast alone left open: it clears itself after
		// TIMING.TOAST_DURATION_MS.error, and nothing said "still unsaved"
		// after that. This line is what a failure looks like once it has.
		useSaveStore.setState({ status: "error", lastErrorMessage: "database is locked" });
		renderDock();
		expect(liveSaveLine()).toBe("Not saved");
	});

	it("keeps the Dock reporting the states that are not failures", () => {
		useSaveStore.setState({ status: "saving" });
		renderDock();
		expect(liveSaveLine()).toBe("Saving…");

		cleanup();
		useSaveStore.setState({ status: "saved" });
		renderDock();
		expect(liveSaveLine()).toBe("Saved");
	});
});

/**
 * `pending` was the same defect one field over: `markPendingSave` set it on
 * every edit and no surface rendered it. That is harmless while auto-save is
 * on - the status resolves itself within the delay - but auto-save is a
 * setting, and with it off nothing in the app said "unsaved" at all. The tab
 * strip deliberately carries no unsaved-dot, so the Dock is the only place
 * left to say it.
 */
describe("unsaved work is visible", () => {
	it("renders the pending status the save pipeline writes", () => {
		useSaveStore.setState({ status: "pending" });
		renderDock();
		expect(liveSaveLine()).toBe("Unsaved changes");
	});

	it("says nothing at all once the save has settled", () => {
		renderDock();
		expect(liveSaveLine()).toBe("");
	});

	it("is reachable from the store the editors actually call", () => {
		// The seam: if `markPendingSave` stops setting "pending", the Dock case
		// above renders for nothing.
		useSaveStore.getState().markPendingSave();
		expect(useSaveStore.getState().status).toBe("pending");
	});

	it("gives every status a reader now that the write-only fields are gone", () => {
		// `lastSavedAt` and `pendingSaveId` were written by this store and read
		// by nothing; deleting them left `status` as its whole public surface.
		expect(Object.keys(useSaveStore.getState())).not.toContain("lastSavedAt");
		expect(Object.keys(useSaveStore.getState())).not.toContain("pendingSaveId");
	});
});

/*
 * The save line does not jump the strip around it, and costs nothing while
 * idle.
 *
 * The four lines used to be four `{status === "x" && …}` children of the Dock's
 * ambient group. That group is centred in the strip by two equal `flex-1`
 * gutters, so its own width decides where it starts and every item in it moves
 * when that width changes - and one edit walks the store `pending` -> `saving`
 * -> `saved` -> `idle`, four different widths within a couple of seconds. The
 * connection light slid one way and the version string the other, on every
 * keystroke sequence typed anywhere in the app. A first fix reserved the widest
 * line's width permanently, which stopped the jump but left a standing gap on
 * every screen where nothing was being saved - the far more common case.
 *
 * jsdom lays nothing out, so the animated width itself is unobservable here
 * (the same limit `tabs.test.tsx` hits for `MARK_TRACK`). What is observable is
 * the mechanism: the slot is in the DOM in every state including `idle`, it is
 * the *same* node across a transition rather than a remount, and its
 * `grid-template-columns` track and cancelling margin flip between the zero
 * and full-width classes as the status changes.
 *
 * Mutation check (confirmed): put the four `{saveStatus === "x" && …}` spans
 * back in place of `<SaveStatusLine />` and "keeps the slot in the DOM" and
 * "reuses the same node" both fail on the absent slot; swap the
 * `grid-cols-[0fr]`/`grid-cols-[1fr]` branches in `SaveStatusLine` and "opens
 * the track when a save state arrives" fails on the inverted classes.
 */
describe("the save line holds its own width", () => {
	const slot = () => document.querySelector<HTMLElement>("[data-slot='dock-save-status']");

	it("keeps the slot in the DOM with nothing to say, at a zero-width track", () => {
		renderDock();
		expect(slot(), "no slot - the line will widen the group when it arrives").not.toBeNull();
		expect(slot()?.className).toContain("grid-cols-[0fr]");
		// Cancels the row's leading gap-4 (not the trailing one, or the row's
		// only surviving gap-4 would vanish too - see the note in Dock.tsx).
		// `-mx-4` (both sides) shipped once and jammed "Connected" straight
		// against the version string with no gap at all - this guards the
		// single-sided form specifically, not just "some cancelling margin".
		expect(slot()?.className).toContain("-ms-4");
		expect(slot()?.className).not.toContain("-mx-4");
		expect(slot()?.className).not.toContain("-me-4");
	});

	it("opens the track when a save state arrives", () => {
		renderDock();
		act(() => useSaveStore.setState({ status: "pending" }));
		expect(slot()?.className).toContain("grid-cols-[1fr]");
		expect(slot()?.className).toContain("ms-0");
	});

	it("reuses the same node across the whole save cycle", () => {
		renderDock();
		const idle = slot()!;

		for (const status of ["pending", "saving", "saved"] as const) {
			// `act`, or React batches the store write past the assertion and the
			// node-identity check below passes without anything having rerendered.
			act(() => useSaveStore.setState({ status }));
			const next = slot()!;
			// The same element, not a remount: only its track and live cell
			// changed, so nothing was inserted into or removed from the centred
			// group.
			expect(next, `the slot remounted on ${status}`).toBe(idle);
		}

		// The line itself still reads "Saving…" here - `useSaveStatusDisplay`
		// (see the dedicated describe block below) holds that text on screen for
		// SAVING_MIN_VISIBLE_MS before showing "Saved", independent of the slot
		// identity this loop is checking.
		expect(liveSaveLine()).toBe("Saving…");
	});

	it("says nothing at rest, and reaches no screen reader while idle", () => {
		renderDock();
		expect(liveSaveLine()).toBe("");
	});
});

/*
 * The live text does not flash on every step of one save.
 *
 * A `key={line.text}` on the live span used to force a remount on every status
 * change so `.enter-fade` would replay - but `.enter-fade` has no exit half
 * (React removes a conditionally-rendered node synchronously), so the old text
 * vanished in the same frame the new text started fading in from opacity 0.
 * `pending` -> `saving` -> `saved` fired that hard-cut-then-fade three times in
 * a few seconds, which read as a flash rather than motion - worse than the
 * jump the track-animation mechanism exists to smooth over.
 *
 * The track opening from `idle` already carries the "something just appeared"
 * motion; a text change within an already-open track needs none of its own.
 *
 * Mutation check (confirmed): restore `key={line.text}` and `enter-fade` on
 * the live span and "keeps the same text node across a save cycle" fails on
 * the remount; "carries no enter-fade class" fails on the class returning.
 */
describe("the save line's text does not flash on every step of one save", () => {
	const liveTextNode = () =>
		document.querySelector<HTMLElement>("[data-slot='dock-save-status'] span span");

	it("keeps the same text node across a save cycle, not a remount per state", () => {
		renderDock();
		act(() => useSaveStore.setState({ status: "pending" }));
		const pendingNode = liveTextNode()!;

		act(() => useSaveStore.setState({ status: "saving" }));
		const savingNode = liveTextNode()!;
		expect(savingNode, "remounted on pending -> saving").toBe(pendingNode);

		act(() => useSaveStore.setState({ status: "saved" }));
		const savedNode = liveTextNode()!;
		expect(savedNode, "remounted on saving -> saved").toBe(pendingNode);
	});

	it("carries no enter-fade class, so a text change replays no fade", () => {
		renderDock();
		act(() => useSaveStore.setState({ status: "pending" }));
		expect(liveTextNode()?.className).not.toContain("enter-fade");

		act(() => useSaveStore.setState({ status: "saving" }));
		expect(liveTextNode()?.className).not.toContain("enter-fade");
	});
});

/*
 * "Saving…" holds the screen for SAVING_MIN_VISIBLE_MS before "Saved" can
 * replace it - `useSaveStatusDisplay`'s own floor, distinct from the "no
 * flash on a text change" cases above (those are about *how* a change is
 * shown; this is about *when* one particular change is allowed to happen).
 *
 * A save against the local engine often lands in well under
 * SAVING_MIN_VISIBLE_MS, which used to mean "Saving…" was on screen for less
 * time than a person needs to register a state change at all - the store's
 * own `status` jumped `pending` -> `saving` -> `saved` inside one render, and
 * the Dock showed exactly that. The hook is what holds the *display* back on
 * "saving" a beat past a "saved" it has already received, without touching
 * `save-store.ts` itself - every other reader of `status` still gets the
 * truth the instant it changes.
 *
 * Mutation check (confirmed): hardcode `remaining` to `0` in
 * `useSaveStatusDisplay` and "holds 'Saving…' until the floor" fails on the
 * line reading "Saved" immediately; drop the `elapsed`/`remaining`
 * computation entirely (jump straight from "saving" to "saved" with no
 * `setTimeout`) and the same case fails the same way.
 */
describe("the save line's floor on how long 'Saving…' stays up", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useSaveStore.setState({ status: "idle", lastErrorMessage: null });
		useToastStore.setState({ toasts: [] });
	});

	afterEach(() => {
		vi.useRealTimers();
		cleanup();
	});

	it("holds 'Saving…' until the floor, then shows 'Saved'", () => {
		renderDock();
		act(() => useSaveStore.setState({ status: "saving" }));
		act(() => useSaveStore.setState({ status: "saved" }));

		expect(liveSaveLine()).toBe("Saving…");

		act(() => vi.advanceTimersByTime(TIMING.SAVING_MIN_VISIBLE_MS - 1));
		expect(liveSaveLine()).toBe("Saving…");

		act(() => vi.advanceTimersByTime(1));
		expect(liveSaveLine()).toBe("Saved");
	});

	it("does not hold a failure behind the floor", () => {
		renderDock();
		act(() => useSaveStore.setState({ status: "saving" }));
		act(() =>
			useSaveStore.setState({ status: "error", lastErrorMessage: "database is locked" })
		);

		// The floor only ever applies to saving -> saved.
		expect(liveSaveLine()).toBe("Not saved");
	});

	it("does not add to a save already slower than the floor", () => {
		renderDock();
		act(() => useSaveStore.setState({ status: "saving" }));
		act(() => vi.advanceTimersByTime(TIMING.SAVING_MIN_VISIBLE_MS + 500));

		act(() => useSaveStore.setState({ status: "saved" }));

		// Already past the floor when "saved" arrived - no further wait.
		expect(liveSaveLine()).toBe("Saved");
	});
});

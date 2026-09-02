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
 * What the palette promises: the chord reaches it from anywhere, typing part of
 * a name finds the thing, Enter opens it, and Escape puts focus back where it
 * was.
 *
 * Two of those are guards against a specific way of failing:
 *
 * - **Capture phase.** Monaco consumes ⌘K as a chord prefix and stops it
 *   propagating, so a bubble-phase listener never sees the key while the caret
 *   is in an editor. The test dispatches through an element that calls
 *   `stopPropagation`, which is what an editor does; move the listener to the
 *   bubble and it fails.
 * - **Focus restoration.** Radix restores to a dialog's trigger, and a palette
 *   opened by a chord has none, so the module captures and restores it itself.
 *   Drop that and this fails with focus on `<body>` - which is what it did
 *   before the capture was added.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CommandPalette } from "./CommandPalette";
import { useImportModalStore, useLayoutStore, useTabsStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { useLiveCommandSurfaceStore } from "@/lib/commands";
import { CLOSE_TAB_CHORD } from "@/constants/shortcuts";
import { chordKeys, isMac } from "@/lib/platform";
import { formatRelativeTime } from "@/utils";
import { RECENT_LIMIT } from "./ranking";

/**
 * The primary modifier as this platform sends it.
 *
 * The chord is `mod: "strict"` (#938): the platform's own modifier and not the
 * other one, so that Ctrl+K on a Mac stays the focused field's
 * kill-to-end-of-line. These cases used to hardcode `metaKey`, which is a host
 * assumption of the kind `platform.test.ts` exists to warn about - it passed on
 * Linux CI only because the modifier was lenient. The strict branches
 * themselves are asserted under a stubbed platform in
 * `CommandPalette.ctrl-k.test.tsx`.
 */
const MOD = isMac ? { metaKey: true } : { ctrlKey: true };

const COLLECTIONS = [
	{ id: "c1", name: "Payments", parentId: undefined },
	{ id: "c2", name: "Auth", parentId: "c1" },
];

const REQUESTS = new Map([
	[
		"c1",
		[
			{ id: "r1", collectionId: "c1", name: "Charge card", method: "POST", url: "/charges" },
			{ id: "r2", collectionId: "c1", name: "Refund", method: "POST", url: "/refunds" },
		],
	],
	["c2", [{ id: "r3", collectionId: "c2", name: "Issue token", method: "GET", url: "/token" }]],
]);

/** Runs, newest-first, as the infinite query hands them over. */
let runPages: { data: { id: string; requestId: string | null; startTime: number }[] }[] = [
	{ data: [] },
];

vi.mock("@/queries", () => ({
	requestDetailOptions: () => ({
		queryKey: ["request"],
		queryFn: async () => undefined,
		enabled: false,
	}),
	runDetailOptions: () => ({ queryKey: ["run"], queryFn: async () => undefined, enabled: false }),
	useCollectionsQuery: () => ({ data: COLLECTIONS }),
	useMultipleCollectionRequests: () => ({ requestsByCollection: REQUESTS, isLoading: false }),
	useRunsQuery: () => ({ data: { pages: runPages } }),
	// The deep sources (phase 3). Their own behaviour lives in
	// `deep-sources.test.tsx`; here they only have to exist so the list renders.
	useConfigQuery: () => ({ data: { entries: [] } }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: undefined }),
	useRunSearchQuery: () => ({ data: undefined, isError: false }),
	flattenRunPages: (data?: { pages: { data: unknown[] }[] }) =>
		data ? data.pages.flatMap((p) => p.data) : [],
	// Reached through the command surfaces the palette now hosts: the shared
	// new-request flow and the run dialog.
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn() }),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn() }),
	useStartScenarioRunMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

function renderPalette() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			{/* A focusable neighbour, so "focus goes back where it was" has
			    somewhere to go back to. */}
			<input aria-label="outside" />
			<CommandPalette />
		</QueryClientProvider>
	);
}

/** Dispatch ⌘K the way an editor does: swallowed before it can bubble. */
function pressPaletteChordInsideAnEditor() {
	const editor = document.createElement("div");
	editor.addEventListener("keydown", (e) => e.stopPropagation());
	document.body.appendChild(editor);
	act(() =>
		editor.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "k",
				...MOD,
				bubbles: true,
				cancelable: true,
			})
		)
	);
	editor.remove();
}

/** Open it the way the store does, inside `act` so the dialog mounts. */
function open() {
	act(() => useLayoutStore.getState().setPaletteOpen(true));
}

/** The palette's search field. */
function input(): HTMLInputElement {
	return screen.getByPlaceholderText(/Search tabs/) as HTMLInputElement;
}

function typeQuery(text: string) {
	fireEvent.change(input(), { target: { value: text } });
}

/** Enter on the highlighted row - cmdk handles the key on its root. */
function pressEnter() {
	fireEvent.keyDown(input(), { key: "Enter" });
}

/** The rows under one heading, in visible order. */
function rowsUnder(heading: string): string[] {
	const group = screen.getByText(heading).closest("[cmdk-group]")!;
	return [...group.querySelectorAll("[cmdk-item]")].map(
		(el) => el.querySelector("span.flex-1")?.textContent ?? ""
	);
}

/** Every group heading on screen, in visible order. */
function headings(): string[] {
	return [...document.querySelectorAll("[cmdk-group-heading]")].map((el) => el.textContent ?? "");
}

/** Every result row on screen, in visible order. Escape rows are not results. */
function visibleRows(): string[] {
	return [...document.querySelectorAll("[cmdk-item]")]
		.filter((el) => el.closest("[cmdk-group]")?.querySelector("[cmdk-group-heading]"))
		.map((el) => el.querySelector("span.flex-1")?.textContent ?? "");
}

beforeEach(() => {
	// cmdk scrolls the highlighted row into view; jsdom has no such method.
	Element.prototype.scrollIntoView = vi.fn();
	runPages = [{ data: [] }];
	useLayoutStore.setState({ paletteOpen: false, drawerOpen: false, drawerView: "collections" });
	useTabsStore.setState({ openTabs: [], activeTabId: null, tabFocusedAt: {} });
	useImportModalStore.setState({ isOpen: false });
	useSettingsStore.setState({ selectedCategory: "appearance", highlightedKey: null });
	useLiveCommandSurfaceStore.setState({ startLoadTest: null });
});
afterEach(cleanup);

describe("the ⌘K chord", () => {
	it("opens the palette even when an editor swallows the key", () => {
		renderPalette();
		pressPaletteChordInsideAnEditor();
		expect(useLayoutStore.getState().paletteOpen).toBe(true);
	});

	it("closes it again, so the chord that opened it dismisses it", () => {
		renderPalette();
		pressPaletteChordInsideAnEditor();
		pressPaletteChordInsideAnEditor();
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
	});

	it("ignores the key without the modifier, and ⇧⌘K", () => {
		renderPalette();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "K", ...MOD, shiftKey: true, bubbles: true })
		);
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
	});

	it("matches the chord under Caps Lock, which reports an upper-case key", () => {
		renderPalette();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "K", ...MOD, bubbles: true }));
		expect(useLayoutStore.getState().paletteOpen).toBe(true);
	});
});

describe("searching", () => {
	it("finds a request by part of its name and opens its tab on Enter", async () => {
		renderPalette();
		open();

		typeQuery("refu");
		pressEnter();

		const { openTabs, activeTabId } = useTabsStore.getState();
		expect(openTabs).toHaveLength(1);
		expect(openTabs[0]).toMatchObject({ type: "request", entityId: "r2" });
		expect(activeTabId).toBe(openTabs[0].id);
		// A pick always closes it - a palette left open over the thing it just
		// opened is in the way.
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
	});

	it("finds a request by its URL, which its name need not mention", async () => {
		renderPalette();
		open();

		typeQuery("/token");
		expect(screen.getByText("Issue token")).toBeInTheDocument();
		expect(screen.queryByText("Charge card")).not.toBeInTheDocument();
	});

	it("shows a collection's path, so two same-named requests are told apart", async () => {
		renderPalette();
		open();
		// "Auth" is nested under "Payments", and its request says so.
		expect(screen.getByText("Payments / Auth")).toBeInTheDocument();
	});

	/*
	 * Saying so is half of it. A launcher that matched nothing offers what it
	 * can still do (#1177) - drop the verbs from the no-match branch of
	 * `ranking.ts` and the palette is a dead end again, which is what the second
	 * half of this asserts.
	 */
	it("says nothing matched, and offers the verbs instead of a dead end", async () => {
		renderPalette();
		open();
		typeQuery("zzzzz");

		expect(screen.getByText(/No matches for “zzzzz”/)).toBeInTheDocument();
		expect(rowsUnder("Quick actions")).toContain("Import collection");
		// Suggestions are not results: the announcement still says the query
		// narrowed everything away.
		expect(screen.getByText(/searchable results$/).textContent).toBe("0 searchable results");
	});

	/*
	 * The reported symptom (#1175), end to end. "theme" scores Theme Mode at
	 * 0.99 and the request rows at 0.01-0.10, and the user saw the requests:
	 * the sections rendered in a fixed order no score could cross. Put the
	 * wrapper back in charge - drop the promotion in `ranking.ts` - and the
	 * first row is a request again.
	 */
	it("puts the setting a query names first, above better-placed sections", async () => {
		renderPalette();
		open();

		typeQuery("theme");

		expect(visibleRows()[0]).toBe("Theme Mode");
		const headings = [...document.querySelectorAll("[cmdk-group-heading]")].map(
			(el) => el.textContent
		);
		expect(headings[0]).toBe("Top result");
	});

	/*
	 * The floor. Every request here matches "theme" only as scattered
	 * subsequence noise through a URL, which is how they outranked the setting
	 * in the first place - so none of them may render at all.
	 */
	it("does not render a row that matched only as subsequence noise", async () => {
		renderPalette();
		open();

		typeQuery("theme");

		expect(screen.queryByText("Charge card")).not.toBeInTheDocument();
		expect(screen.queryByText("Refund")).not.toBeInTheDocument();
		expect(screen.queryByText("Issue token")).not.toBeInTheDocument();
	});

	/*
	 * The announced count is the rendered count. It used to be summed from the
	 * pre-filter groups, so a typed query announced every row the sources had
	 * produced - the comment above it said as much and the line below did the
	 * opposite.
	 */
	it("announces the number of rows it actually rendered", async () => {
		renderPalette();
		open();

		typeQuery("theme");

		const announced = screen.getByText(/searchable results$/).textContent ?? "";
		expect(announced).toBe(`${visibleRows().length} searchable results`);
	});

	it("switches to an open tab rather than opening a second one", async () => {
		useTabsStore.setState({
			openTabs: [
				{ id: "t1", type: "settings", entityId: null },
				{ id: "t2", type: "inbox", entityId: null },
			],
			activeTabId: "t2",
			tabFocusedAt: {},
		});
		renderPalette();
		open();

		typeQuery("Settings");
		pressEnter();

		const state = useTabsStore.getState();
		expect(state.openTabs).toHaveLength(2);
		expect(state.activeTabId).toBe("t1");
	});
});

describe("the empty query", () => {
	it("puts the most recently focused tab first", async () => {
		useTabsStore.setState({
			openTabs: [
				{ id: "t1", type: "settings", entityId: null },
				{ id: "t2", type: "inbox", entityId: null },
				{ id: "t3", type: "variables", entityId: null },
			],
			activeTabId: "t1",
			// Insertion order is t1, t2, t3; attention order is t2, t3, t1.
			tabFocusedAt: { t1: 1000, t2: 3000, t3: 2000 },
		});
		renderPalette();
		open();

		// Recency is what Recents is ordered by, and a dated row is lifted into
		// it - so this is where the attention order shows, rather than inside
		// Tabs as it did before the section existed.
		expect(rowsUnder("Recents")).toEqual(["Inbox", "Variables", "Settings"]);
	});

	it("puts the most recently sent request first", async () => {
		runPages = [
			{
				data: [
					{ id: "run2", requestId: "r2", startTime: 5000 },
					{ id: "run1", requestId: "r1", startTime: 1000 },
				],
			},
		];
		renderPalette();
		open();

		// Tree order is Charge card, Refund, Issue token; Refund ran last, and
		// Issue token has never run, so it is not recent at all.
		expect(rowsUnder("Recents")).toEqual(["Refund", "Charge card"]);
		expect(rowsUnder("Requests")).toEqual(["Issue token"]);
	});

	it("keeps the groups in a fixed order", async () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "settings", entityId: null }],
			activeTabId: "t1",
			tabFocusedAt: {},
		});
		renderPalette();
		open();

		expect(screen.getByText("Tabs")).toBeInTheDocument();
		// Nothing here is dated - no focus time, no runs - so Recents is absent
		// and the verbs lead. "Commands" does not appear: on an empty query its
		// rows are Quick actions.
		expect(headings()).toEqual([
			"Quick actions",
			"Tabs",
			"Requests",
			"Collections",
			"Views",
			"Settings",
		]);
	});
});

/**
 * The launcher affordances (#1176): the two sections the empty query leads
 * with, the chord chips, and the hints under the list.
 *
 * The thing each of these is guarding is the same one the top result guards -
 * a section above the fixed order holds rows *lifted* out of the sections
 * below, never copied into it. Two rows carrying the same cmdk `value` both
 * read as selected, and both would be counted.
 */
describe("the launcher sections", () => {
	/** Three tabs and two sent requests: five dated rows, one short of the cap. */
	function withRecentActivity() {
		useTabsStore.setState({
			openTabs: [
				{ id: "t1", type: "settings", entityId: null },
				{ id: "t2", type: "inbox", entityId: null },
				{ id: "t3", type: "variables", entityId: null },
			],
			activeTabId: "t1",
			tabFocusedAt: { t1: 9000, t2: 8000, t3: 7000 },
		});
		runPages = [
			{
				data: [
					{ id: "run2", requestId: "r2", startTime: 5000 },
					{ id: "run1", requestId: "r1", startTime: 1000 },
				],
			},
		];
	}

	it("leads with Recents, then the verbs, above the fixed order", () => {
		withRecentActivity();
		renderPalette();
		open();

		expect(headings().slice(0, 2)).toEqual(["Recents", "Quick actions"]);
	});

	it("lifts a recent row out of its own section rather than copying it", () => {
		withRecentActivity();
		renderPalette();
		open();

		const rows = visibleRows();
		// A lifted row appears exactly once in the whole list. Only the request
		// names are asserted this way: a tab reads as its view does ("Inbox" is
		// both an open tab and the drawer view), so a count would be testing
		// that coincidence rather than the lift.
		for (const label of ["Refund", "Charge card"]) {
			expect(rows.filter((row) => row === label)).toHaveLength(1);
		}
		// The section a row was lifted from no longer lists it - and with every
		// tab dated, Tabs has nothing left to render at all.
		expect(screen.queryByText("Tabs")).not.toBeInTheDocument();
		expect(rowsUnder("Requests")).toEqual(["Issue token"]);
	});

	it("counts a lifted row once in the announcement", () => {
		withRecentActivity();
		renderPalette();
		open();

		const announced = screen.getByText(/^\d+ results$/).textContent ?? "";
		expect(announced).toBe(`${visibleRows().length} results`);
	});

	it("caps Recents, keeping the newest", () => {
		useTabsStore.setState({
			openTabs: Array.from({ length: RECENT_LIMIT + 2 }, (_, i) => ({
				id: `t${i}`,
				type: "settings" as const,
				entityId: null,
			})),
			activeTabId: "t0",
			// t0 is the oldest, so the two oldest fall off the end of the cap.
			tabFocusedAt: Object.fromEntries(
				Array.from({ length: RECENT_LIMIT + 2 }, (_, i) => [`t${i}`, 1000 + i])
			),
		});
		renderPalette();
		open();

		expect(rowsUnder("Recents")).toHaveLength(RECENT_LIMIT);
		// The two that did not fit are still reachable, in the section they
		// were lifted from - a cap must not make a row unreachable.
		expect(rowsUnder("Tabs")).toHaveLength(2);
	});

	it("says how long ago a recent row was touched", () => {
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		runPages = [{ data: [{ id: "run2", requestId: "r2", startTime: fiveMinutesAgo }] }];
		renderPalette();
		open();

		const row = screen.getByText("Refund").closest("[cmdk-item]")!;
		expect(row.textContent).toContain(formatRelativeTime(fiveMinutesAgo));
	});

	it("offers the verbs on an empty query and ranks them as Commands on a typed one", () => {
		renderPalette();
		open();

		expect(rowsUnder("Quick actions")).toContain("Import collection");
		expect(screen.queryByText("Commands")).not.toBeInTheDocument();

		typeQuery("import");
		expect(screen.queryByText("Quick actions")).not.toBeInTheDocument();
		expect(screen.queryByText("Recents")).not.toBeInTheDocument();
		expect(visibleRows()).toContain("Import collection");
	});

	/*
	 * Nothing here asserts a platform, for the reason `KeyboardShortcutsPanel`'s
	 * tests give: `chordKeys` answers differently on macOS and elsewhere, and the
	 * rule being held is that the row reads the chord the handler matches rather
	 * than spelling one of its own. So the caps are compared to what `chordKeys`
	 * returns for that same chord, which fails on a hardcoded string, on
	 * `formatChord`'s single joined cap, and on the wrong chord.
	 */
	it("prints a row's chord as key-caps, one Kbd per key", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "inbox", entityId: null }],
			activeTabId: "t1",
			tabFocusedAt: {},
		});
		renderPalette();
		open();

		const row = screen.getByText('Close "Inbox"').closest("[cmdk-item]")!;
		const caps = [...row.querySelectorAll("kbd")].map((el) => el.textContent);
		expect(caps).toEqual(chordKeys(CLOSE_TAB_CHORD));
	});

	it("prints no caps on a row no chord runs", () => {
		renderPalette();
		open();

		// The registry binds no chord to importing - and a made-up one on screen
		// is worse than none, since nothing would answer it.
		const row = screen.getByText("Import collection").closest("[cmdk-item]")!;
		expect(row.querySelectorAll("kbd")).toHaveLength(0);
	});

	it("puts the keyboard hints outside the band that scrolls", () => {
		renderPalette();
		open();

		const footer = document.querySelector('[data-slot="command-footer"]')!;
		expect(footer).toBeInTheDocument();
		expect(footer.textContent).toContain("navigate");
		// Inside `CommandList` the hints would scroll away with the results
		// they describe - which is the whole reason the band exists (#773).
		expect(footer.closest('[data-slot="command-list"]')).toBeNull();
	});
});

/**
 * How much of the list is on screen (#1177). The primitive's 300px showed about
 * six rows at the old density, so the Settings section a query named sat below
 * the fold with nothing saying it was there - the search fix put the right row
 * first, and this is what makes the rest of the answer visible.
 */
describe("the list's height", () => {
	it("caps the list at about eleven rows, and at 60vh before that", () => {
		renderPalette();
		open();

		const list = document.querySelector('[data-slot="command-list"]')!;
		const cls = (list.getAttribute("class") ?? "").split(/\s+/);
		expect(cls).toContain("max-h-[min(400px,60vh)]");
		// tailwind-merge has to have dropped the primitive's own cap, or both
		// declarations ship and the smaller one wins on source order.
		expect(cls).not.toContain("max-h-[300px]");
	});

	it("pins the row padding the row count is counted in", () => {
		/*
		 * The cap is one input to "about eleven rows"; the row's own height is
		 * the other, and a padding change would halve the visible count with the
		 * assertion above still green - jsdom has no layout, so nothing here can
		 * measure the rows themselves. So pin the padding they are drawn with:
		 * `CommandItem`'s `px-2 py-1.5` is the 32px single-line row, read off a
		 * rendered palette row rather than the primitive, since a caller's
		 * `className` goes through tailwind-merge and can replace it - which is
		 * exactly what `command.chrome.test.tsx`'s density read of the bare
		 * primitive cannot see.
		 *
		 * The row *count* itself stays a manual measurement: eleven rows and two
		 * headings in Chromium at a 768px window, nine at 600px (#1177).
		 */
		renderPalette();
		open();

		const row = document.querySelector('[data-slot="command-item"]');
		expect(row).not.toBeNull();
		const cls = (row?.getAttribute("class") ?? "").split(/\s+/);
		expect(cls).toContain("px-2");
		expect(cls).toContain("py-1.5");
	});
});

/**
 * The registry's half of the palette. The point of these is that the palette
 * *offers* the roster and runs it - the commands themselves are held to their
 * behaviour in `lib/commands/registry.test.ts`, and duplicating that here would
 * be two tests for one rule.
 */
describe("commands", () => {
	it("finds a command by name and performs it on Enter", () => {
		renderPalette();
		open();

		typeQuery("import");
		pressEnter();

		expect(useImportModalStore.getState().isOpen).toBe(true);
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
	});

	it("finds a settings section by name and reveals it", () => {
		renderPalette();
		open();

		typeQuery("notificat");
		pressEnter();

		expect(useSettingsStore.getState().selectedCategory).toBe("notifications");
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({ type: "settings" });
	});

	it("offers the collection command only while a collection tab is active", () => {
		renderPalette();
		open();
		expect(screen.queryByText(/^Run "/)).not.toBeInTheDocument();
		cleanup();

		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "collection", entityId: "c1" }],
			activeTabId: "t1",
			tabFocusedAt: {},
		});
		renderPalette();
		open();
		// Named after its target, so Enter holds no surprise.
		expect(screen.getByText('Run "Payments"')).toBeInTheDocument();
	});

	/*
	 * The join the two ends cannot prove on their own: the registry declares the
	 * command available when a surface exists, the builder publishes one, and this
	 * hook is what carries the second to the first. Drop the merge in
	 * `useCommandSurfaces` and the row never appears.
	 */
	it("offers the load-test command only while a mounted builder contributes it", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
			activeTabId: "t1",
			tabFocusedAt: {},
		});
		renderPalette();
		open();
		// Named after the tab, like the other contextual commands. The request
		// query is stubbed empty here, so the strip calls this tab "Request".
		expect(screen.queryByText('Load test "Request"')).not.toBeInTheDocument();
		cleanup();

		const started = vi.fn();
		useLiveCommandSurfaceStore.setState({ startLoadTest: started });
		renderPalette();
		open();
		expect(screen.getByText('Load test "Request"')).toBeInTheDocument();

		typeQuery('Load test "Req');
		pressEnter();

		expect(started).toHaveBeenCalledTimes(1);
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
	});

	it("keeps the run dialog on screen after the pick closes the palette", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "collection", entityId: "c1" }],
			activeTabId: "t1",
			tabFocusedAt: {},
		});
		renderPalette();
		open();

		typeQuery('Run "Pay');
		pressEnter();

		// The dialog is hosted beside the palette, not inside it - inside, the
		// pick that opened it would unmount it in the same commit.
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
		expect(screen.getByRole("dialog", { name: /Run Payments/ })).toBeInTheDocument();
	});
});

describe("closing", () => {
	it("puts focus back where it was", async () => {
		renderPalette();
		const outside = screen.getByLabelText("outside");
		outside.focus();
		expect(document.activeElement).toBe(outside);

		open();
		expect(input()).toBeInTheDocument();
		fireEvent.keyDown(document, { key: "Escape" });

		await waitFor(() => expect(useLayoutStore.getState().paletteOpen).toBe(false));
		await waitFor(() => expect(document.activeElement).toBe(outside));
	});

	it("starts empty on the next open rather than restoring the last query", async () => {
		renderPalette();
		open();
		typeQuery("refu");
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(useLayoutStore.getState().paletteOpen).toBe(false));

		pressPaletteChordInsideAnEditor();
		expect(input().value).toBe("");
	});
});

describe("cost", () => {
	it("renders no results at all while shut", () => {
		renderPalette();
		expect(screen.queryByText("Views")).not.toBeInTheDocument();
	});
});

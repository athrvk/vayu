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
 * The explorer pane: what it draws, what it remembers, and how it is driven
 * from a keyboard.
 *
 * The tree model itself is pinned in `schema-tree.test.ts` against the fixture
 * schema; these cover the things only a rendered pane has - the bounded row
 * count, the roving focus, and the state that has to survive Radix unmounting
 * the Body tab.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { buildSchema } from "graphql";
import { TooltipProvider } from "@/components/ui";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
import { SchemaExplorer } from "./SchemaExplorer";
import type { SchemaEntry } from "@/lib/graphql/schema-cache";
import type { SchemaTreeNode } from "@/lib/graphql/schema-tree";

const KEY = "test-schema-key";
const schema = fixtureSchema();

/**
 * jsdom has no `IntersectionObserver`, and `useGrowingWindow` honestly
 * degrades to rendering everything when there is none - so without this stub
 * the windowing test would measure the fallback rather than the window.
 */
class StubObserver {
	observe() {}
	disconnect() {}
}

/** The cache snapshot the pane reads, defaulted to a schema in hand. */
function entryOf(overrides: Partial<SchemaEntry> = {}): SchemaEntry {
	return { status: "ready", schema, error: null, fetchedAt: Date.now(), ...overrides };
}

function renderExplorer(
	overrides: Omit<Partial<Parameters<typeof SchemaExplorer>[0]>, "entry"> & {
		entry?: Partial<SchemaEntry>;
	} = {}
) {
	const onInsert = vi.fn();
	const onRefresh = vi.fn();
	const onClose = vi.fn();
	const { entry, ...rest } = overrides;
	const view = render(
		<TooltipProvider>
			<SchemaExplorer
				entry={entryOf(entry)}
				schemaKey={KEY}
				onRefresh={onRefresh}
				onClose={onClose}
				onInsert={onInsert}
				{...rest}
			/>
		</TooltipProvider>
	);
	return { onInsert, onRefresh, onClose, view };
}

const rows = () => screen.getAllByRole("treeitem");
const rowNamed = (label: string) => rows().find((r) => r.getAttribute("data-tree-label") === label);

/** The text of a row's name span - the whole name, however it was cut up. */
const name = (row: HTMLElement) => row.querySelector("[data-tree-name]")!.textContent;

/** A row's description span, clipped or full - null when the node documents nothing. */
const descriptionOf = (row: HTMLElement) => row.querySelector("[data-tree-description]");

beforeEach(() => {
	vi.stubGlobal("IntersectionObserver", StubObserver);
	useExplorerStore.setState({ open: false, byKey: {}, lru: [] });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("the tree", () => {
	it("opens on the branches and nothing else", () => {
		renderExplorer();
		expect(rows().map((r) => r.getAttribute("data-tree-label"))).toEqual([
			"Query",
			"Mutation",
			"Subscription (not executable)",
			"Types",
		]);
	});

	it("expands a branch into its fields", () => {
		renderExplorer();
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);
		expect(rows().map((r) => r.getAttribute("data-tree-label"))).toContain("search");
	});

	it("states its depth, so the level is not lost in a flat list", () => {
		renderExplorer();
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);
		expect(rowNamed("Query")!.getAttribute("aria-level")).toBe("1");
		expect(rowNamed("search")!.getAttribute("aria-level")).toBe("2");
	});

	it("strikes a deprecated field through and says why", () => {
		renderExplorer();
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);
		const legacy = rowNamed("legacySearch")!;
		expect(legacy.querySelector(".line-through")).not.toBeNull();
		expect(legacy.getAttribute("title")).toContain("Use search.");
	});

	it("shows a field's description beside it", () => {
		renderExplorer();
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);
		expect(rowNamed("search")!.textContent).toContain("Search across users and posts.");
	});

	it("says on the row that a subscription cannot be run", () => {
		renderExplorer();
		fireEvent.click(
			rowNamed("Subscription (not executable)")!.querySelector("[data-tree-toggle]")!
		);
		expect(rowNamed("postAdded")!.getAttribute("title")).toContain("cannot be run here");
	});

	it("hands the activated row to the caller rather than editing anything itself", () => {
		const { onInsert } = renderExplorer();
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);
		fireEvent.click(rowNamed("search")!.querySelector("[data-tree-activate]")!);

		const node = onInsert.mock.calls[0][0] as SchemaTreeNode;
		expect(node.name).toBe("search");
		expect(node.rootPath).toEqual([{ parentTypeName: "Query", fieldName: "search" }]);
	});
});

describe("search", () => {
	it("replaces the tree with matches from across the schema", () => {
		renderExplorer();
		fireEvent.change(screen.getByLabelText("Search schema"), { target: { value: "post" } });
		const labels = rows().map((r) => r.getAttribute("data-tree-label"));
		expect(labels).toContain("Post");
		expect(labels).toContain("posts");
		expect(labels).not.toContain("Query");
	});

	it("says so when nothing matches", () => {
		renderExplorer();
		fireEvent.change(screen.getByLabelText("Search schema"), { target: { value: "zzzz" } });
		expect(screen.getByText(/Nothing matches/)).toBeTruthy();
		expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
	});

	it("marks the matched run of a name, so a flat list says why each row is in it", () => {
		renderExplorer();
		fireEvent.change(screen.getByLabelText("Search schema"), { target: { value: "gacy" } });

		const row = rowNamed("legacySearch")!;
		expect(row.querySelector("mark")!.textContent).toBe("gacy");
		// The mark is inside the name, not instead of it: what a screen reader
		// reads out is the same string it read before highlighting existed.
		expect(name(row)).toBe("legacySearch");
	});

	it("leaves a signature-only match unmarked, since its name is not what matched", () => {
		renderExplorer();
		fireEvent.change(screen.getByLabelText("Search schema"), { target: { value: "Ranking" } });

		// `Query.search` mentions Ranking only in its argument list.
		expect(rowNamed("search")!.querySelector("mark")).toBeNull();
		expect(name(rowNamed("search")!)).toBe("search");
		// Same render pass, same term - the type whose name matched is marked.
		expect(rowNamed("Ranking")!.querySelector("mark")!.textContent).toBe("Ranking");
	});

	it("marks nothing when there is no search", () => {
		const { view } = renderExplorer();
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);
		expect(view.container.querySelectorAll("mark")).toHaveLength(0);
	});

	it("finds a row by a word that is only in its description, and marks it there", () => {
		renderExplorer();
		fireEvent.change(screen.getByLabelText("Search schema"), { target: { value: "across" } });

		// "Search across users and posts." is on Query.search and nowhere else.
		const row = rowNamed("search")!;
		expect(row.querySelector("mark")!.textContent).toBe("across");
		// The name is not what matched, so the name itself stays unmarked.
		expect(name(row)).toBe("search");
	});

	it("shows a description-matched row in full, so the mark is not clipped away", () => {
		renderExplorer();
		fireEvent.change(screen.getByLabelText("Search schema"), { target: { value: "across" } });

		const description = descriptionOf(rowNamed("search")!)!;
		expect(description.textContent).toBe("Search across users and posts.");
		expect(description.className).not.toContain("truncate");
	});
});

describe("showing the full description on demand", () => {
	const toggle = () => screen.getByLabelText(/full descriptions/i);

	it("clips a description to one line until asked, then shows all of it", () => {
		renderExplorer();
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);

		const clipped = descriptionOf(rowNamed("search")!)!;
		expect(clipped.className).toContain("truncate");

		fireEvent.click(toggle());

		const shown = descriptionOf(rowNamed("search")!)!;
		expect(shown.textContent).toBe("Search across users and posts.");
		expect(shown.className).not.toContain("truncate");
		expect(shown.className).toContain("whitespace-normal");
	});

	it("says which way it is pointing, so the control is not a mystery", () => {
		renderExplorer();
		expect(toggle().getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(toggle());
		expect(toggle().getAttribute("aria-pressed")).toBe("true");
	});

	it("adds nothing to a row that documents nothing", () => {
		renderExplorer();
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);
		fireEvent.click(toggle());
		// `Query.user` carries no description in the fixture.
		expect(descriptionOf(rowNamed("user")!)).toBeNull();
	});

	it("remembers the choice across a tab glance, and per schema", () => {
		const first = renderExplorer();
		fireEvent.click(toggle());
		first.view.unmount();

		renderExplorer();
		expect(toggle().getAttribute("aria-pressed")).toBe("true");
		cleanup();

		renderExplorer({ schemaKey: "another-endpoint" });
		expect(toggle().getAttribute("aria-pressed")).toBe("false");
	});
});

describe("the rendered row count is bounded", () => {
	it("renders a window of a large schema, and says how much is left", () => {
		const fields = Array.from({ length: 400 }, (_, i) => `field${i}: String`).join("\n");
		const big = buildSchema(`type Query {\n${fields}\n}`);
		useExplorerStore.setState({
			byKey: {
				[KEY]: {
					search: "",
					expanded: ["branch:query"],
					scrollTop: 0,
					showDescriptions: false,
				},
			},
			lru: [KEY],
		});

		renderExplorer({ entry: { schema: big } });

		// 400 fields plus two branch rows, windowed to the first 200.
		expect(rows()).toHaveLength(200);
		expect(screen.getByText(/Showing 200 of 402/)).toBeTruthy();
	});
});

describe("state that has to outlive an unmount", () => {
	it("keeps the search text and the expansion across a tab glance", () => {
		const first = renderExplorer();
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);
		fireEvent.change(screen.getByLabelText("Search schema"), { target: { value: "sea" } });
		first.view.unmount();

		renderExplorer();
		expect((screen.getByLabelText("Search schema") as HTMLInputElement).value).toBe("sea");

		// Clearing the search puts the tree back with Query still open - the
		// expansion was remembered too, not just the box.
		fireEvent.change(screen.getByLabelText("Search schema"), { target: { value: "" } });
		expect(rows().map((r) => r.getAttribute("data-tree-label"))).toContain("search");
	});

	it("keeps two schemas' views apart", () => {
		renderExplorer();
		fireEvent.change(screen.getByLabelText("Search schema"), { target: { value: "sea" } });
		cleanup();

		renderExplorer({ schemaKey: "another-endpoint" });
		expect((screen.getByLabelText("Search schema") as HTMLInputElement).value).toBe("");
	});

	it("restores the scroll position it recorded", () => {
		const { view } = renderExplorer();
		const scroller = view.container.querySelector(".overflow-auto")!;
		fireEvent.scroll(scroller, { target: { scrollTop: 140 } });
		view.unmount();

		const next = renderExplorer();
		const restored = next.view.container.querySelector(".overflow-auto") as HTMLElement;
		expect(restored.scrollTop).toBe(140);
	});
});

describe("the keyboard", () => {
	it("moves focus with the arrows and opens a branch with Right", () => {
		renderExplorer();
		const tree = screen.getByRole("tree");
		act(() => rows()[0].focus());

		fireEvent.keyDown(tree, { key: "ArrowDown" });
		expect(document.activeElement).toBe(rowNamed("Mutation"));

		fireEvent.keyDown(tree, { key: "ArrowRight" });
		expect(rows().map((r) => r.getAttribute("data-tree-label"))).toContain("createPost");
	});

	// Left had nowhere to go here at all before #1237: every row of this tree is
	// a direct child of the tree element, whatever its depth, so a walk up the
	// DOM found no parent and the key silently did nothing. Depth is announced
	// rather than nested, and that is what the tree now reads.
	it("leaves a branch with Left, which this tree's flat DOM cannot say", () => {
		renderExplorer();
		const tree = screen.getByRole("tree");
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);
		act(() => rowNamed("search")!.focus());

		fireEvent.keyDown(tree, { key: "ArrowLeft" });
		expect(document.activeElement).toBe(rowNamed("Query"));
	});

	it("inserts the focused row with Enter", () => {
		const { onInsert } = renderExplorer();
		const tree = screen.getByRole("tree");
		fireEvent.click(rowNamed("Query")!.querySelector("[data-tree-toggle]")!);
		act(() => rowNamed("search")!.focus());

		fireEvent.keyDown(tree, { key: "Enter" });
		expect((onInsert.mock.calls[0][0] as SchemaTreeNode).name).toBe("search");
	});

	it("focuses the search box on /", () => {
		renderExplorer();
		act(() => rows()[0].focus());
		fireEvent.keyDown(screen.getByRole("tree"), { key: "/" });
		expect(document.activeElement).toBe(screen.getByLabelText("Search schema"));
	});

	it("leaves a typed / alone, since it is a legitimate search character", () => {
		renderExplorer();
		const box = screen.getByLabelText("Search schema");
		act(() => (box as HTMLInputElement).focus());
		fireEvent.keyDown(box, { key: "/" });
		// Still in the box, and nothing was preventDefaulted out from under it.
		expect(document.activeElement).toBe(box);
	});
});

describe("what it says when there is no schema", () => {
	it("offers the refresh rather than an empty tree", () => {
		renderExplorer({ entry: { schema: null, status: "error", fetchedAt: null } });
		expect(screen.getByText(/No schema loaded/)).toBeTruthy();
		expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
	});

	it("browses a stale schema and states its age instead of blanking", () => {
		renderExplorer({ entry: { status: "error", fetchedAt: Date.now() - 600_000 } });
		expect(screen.getByText(/Refresh failed/)).toBeTruthy();
		expect(rows().length).toBeGreaterThan(0);
	});
});

describe("the header is where every schema affordance lives", () => {
	it("states the schema's status here, not a pane away", () => {
		renderExplorer();
		expect(screen.getByTitle(/Schema loaded/)).toBeTruthy();
	});

	it("names the failure and the fix when introspection was refused", () => {
		renderExplorer({
			entry: {
				schema: null,
				status: "error",
				fetchedAt: null,
				error: { kind: "auth", message: "401" },
			},
		});
		expect(screen.getByTitle(/Credentials were rejected/).textContent).toContain("No schema");
	});

	it("closes the pane from its own header, since the Query header no longer can", () => {
		const { onClose } = renderExplorer();
		fireEvent.click(screen.getByLabelText("Hide schema"));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

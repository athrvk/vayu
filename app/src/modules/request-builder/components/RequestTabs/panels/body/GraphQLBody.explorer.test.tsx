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
 * The explorer wired to the two editors: what a click writes into the query,
 * where the caret lands, and what happens to the Variables pane.
 *
 * The pure halves are pinned elsewhere (`insert-skeleton.test.ts` for the
 * document edit, `SchemaExplorer.test.tsx` for the pane). What only exists here
 * is the join: one body write carrying both panes, a caret placed against the
 * *new* text rather than the old, and a refusal that reaches a live region
 * instead of being dropped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import { schemaCacheKey, useSchemaCache, type SchemaTarget } from "@/lib/graphql/schema-cache";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
import { parseGraphQLBody } from "@/lib/graphql/graphql-body";
import {
	editorPositions as positions,
	editorReveals as reveals,
	editorSelections as selections,
	editorValues as values,
	fakeEditor,
	monacoStub,
	offsetAt,
	resetEditorStubs,
} from "@/test/monaco-editor-stub";
import { useLayoutStore } from "@/stores";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({
		language,
		value,
		onChange,
		onMount,
	}: {
		language: string;
		value: string;
		onChange: (v: string) => void;
		onMount?: (editor: unknown, monaco: unknown) => void;
	}) => {
		values.set(language, value);
		useEffect(() => {
			onMount?.(fakeEditor(language), monacoStub());
			// Mount once, exactly as a real editor does.
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
		return (
			// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- test stub for the Monaco-backed CodeEditor, driven only by fireEvent.click here
			<div data-testid={`editor-${language}`} onClick={() => onChange(value)}>
				{value}
			</div>
		);
	},
}));

const { GraphQLBody } = await import("./GraphQLBody");

const TARGET = {
	url: "https://api.example.com/graphql",
	resolvedUrl: "https://api.example.com/graphql",
	resolvedAuth: null,
} as unknown as SchemaTarget;

class StubObserver {
	observe() {}
	disconnect() {}
}

/** A parent that owns the body, the way `BodyPanel` does. */
function Harness({ initialBody, onBody }: { initialBody: string; onBody: (b: string) => void }) {
	const [body, setBody] = useState(initialBody);
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<TooltipProvider>
			<GraphQLBody
				body={body}
				onBodyChange={(b) => {
					setBody(b);
					onBody(b);
				}}
				requestId="r1"
				schemaTarget={TARGET}
				onEditorMount={() => {}}
				method="POST"
				variablesDraft={draft}
				onVariablesDraftChange={setDraft}
			/>
		</TooltipProvider>
	);
}

function mount(initialBody: string) {
	const bodies: string[] = [];
	render(<Harness initialBody={initialBody} onBody={(b) => bodies.push(b)} />);
	return {
		bodies,
		lastBody: () => bodies[bodies.length - 1],
		query: () => values.get("graphql") ?? "",
		variables: () => values.get("json") ?? "",
		announcement: () => screen.getByRole("status").textContent ?? "",
	};
}

const rowNamed = (name: string) =>
	screen.getAllByRole("treeitem").find((r) => r.getAttribute("data-tree-label") === name)!;

/** Open a branch and activate one of its fields. */
function insert(branch: string, field: string) {
	fireEvent.click(rowNamed(branch).querySelector("[data-tree-toggle]")!);
	act(() => {
		fireEvent.click(rowNamed(field).querySelector("[data-tree-activate]")!);
	});
}

beforeEach(() => {
	vi.stubGlobal("IntersectionObserver", StubObserver);
	resetEditorStubs();
	useExplorerStore.setState({ open: true, byKey: {}, lru: [] });
	useLayoutStore.setState({ graphqlVariablesCollapsed: false, graphqlVariablesSize: 35 });
	/*
	 * A schema already in hand, so mounting introspects nothing: `ensureSchema`
	 * returns on any entry that is not `idle`, which is also what keeps this
	 * test off the network.
	 */
	const key = schemaCacheKey(TARGET);
	useSchemaCache.setState({
		byKey: { [key]: { status: "ready", schema: fixtureSchema(), error: null, fetchedAt: 1 } },
		lru: [key],
		activeKey: key,
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the pane is only there when it has something to browse", () => {
	it("shows the explorer when it is toggled open", () => {
		mount("");
		expect(screen.getByTestId("graphql-explorer")).toBeTruthy();
	});

	it("stays out of the way when it is closed", () => {
		useExplorerStore.setState({ open: false });
		mount("");
		expect(screen.queryByTestId("graphql-explorer")).toBeNull();
	});

	it("opens and closes from the one control in the Query header", () => {
		useExplorerStore.setState({ open: false });
		mount("");
		fireEvent.click(screen.getByLabelText("Browse schema"));
		expect(screen.getByTestId("graphql-explorer")).toBeTruthy();
		// The same button in the same place, only relabelled: the toggle does not
		// move into the pane it opened, and the pane carries no close of its own.
		fireEvent.click(screen.getByLabelText("Hide schema"));
		expect(screen.queryByTestId("graphql-explorer")).toBeNull();
	});
});

/** The explorer toggle, under whichever of its two labels is current. */
const schemaToggle = () => screen.getByLabelText(/^(Browse|Hide) schema$/);
/** The Query pane's header bar - the box the toggle sits in. */
const queryHeader = () => schemaToggle().closest("div")!;
/**
 * The pane's own title, read inside that header: the schema tree draws a row
 * called "Query" too, and a document-wide text query finds both.
 */
const paneTitle = () =>
	[...queryHeader().querySelectorAll("span")].find((s) => s.textContent === "Query")!;
/**
 * Anything in the Query header that is invisible at rest.
 *
 * jsdom applies no stylesheet, so a hover-reveal is read off the class list
 * rather than a computed opacity - which is also the only way to catch the
 * transparency #1224 retired coming back.
 */
const hiddenAtRest = () =>
	[...queryHeader().querySelectorAll("*")].filter((n) =>
		(n.getAttribute("class") ?? "").includes("opacity-0")
	);

describe("one schema control, in one place, whatever the pane is doing", () => {
	it("draws the same three parts ahead of the pane's title in both states", () => {
		for (const open of [false, true]) {
			useExplorerStore.setState({ open });
			mount("");

			expect(schemaToggle()).toBeTruthy();
			// The status badge, by the sentence only it carries.
			expect(screen.getByTitle(/Schema loaded/)).toBeTruthy();
			expect(screen.getAllByLabelText("Refresh schema")).toHaveLength(1);
			// Mutation check: put the control back on the right of the header -
			// the far side from the pane it opens - and this reds.
			expect(
				paneTitle().compareDocumentPosition(schemaToggle()) &
					Node.DOCUMENT_POSITION_PRECEDING
			).toBeTruthy();

			cleanup();
		}
	});

	it("stands at rest, with nothing waiting for a hover to be found", () => {
		// Mutation check: give the Refresh back its
		// `opacity-0 group-hover:opacity-100` and this reds. A control the user
		// has to already know about does not solve a duplication problem (#507
		// bought "one standing Refresh" with exactly that trade); one home that
		// does not move solves it structurally.
		for (const open of [false, true]) {
			useExplorerStore.setState({ open });
			mount("");
			// The scan is worth nothing if it scanned nothing: a header with the
			// control in it is a dozen nodes deep, and an empty `querySelectorAll`
			// would pass this file for free.
			expect(queryHeader().querySelectorAll("*").length).toBeGreaterThan(5);
			expect(hiddenAtRest()).toEqual([]);
			cleanup();
		}
	});

	it("points the toggle at the left, where the pane opens, and says whether it is open", () => {
		useExplorerStore.setState({ open: false });
		mount("");
		const toOpen = screen.getByLabelText("Browse schema");
		expect(toOpen.getAttribute("aria-expanded")).toBe("false");
		// Mutation check: the `PanelRight*` pair this used to draw names the side
		// the pane does not open on - the explorer is the group's first panel.
		expect(toOpen.querySelector(".lucide-panel-left-open")).toBeTruthy();
		cleanup();

		useExplorerStore.setState({ open: true });
		mount("");
		const toClose = screen.getByLabelText("Hide schema");
		expect(toClose.getAttribute("aria-expanded")).toBe("true");
		expect(toClose.querySelector(".lucide-panel-left-close")).toBeTruthy();
	});

	it("still offers the way in before anything is known about the schema", () => {
		// `idle` is the state the badge itself renders nothing for - the row
		// falls back to a plain label so the pane is still reachable.
		useSchemaCache.setState({ byKey: {}, lru: [], activeKey: null });
		useExplorerStore.setState({ open: false });
		mount("");
		expect(screen.getByLabelText("Browse schema")).toBeTruthy();
		expect(screen.getAllByLabelText("Refresh schema")).toHaveLength(1);
	});
});

describe("refreshing the schema", () => {
	it("calls the cache's one refresh path from either state, and does not open the pane", () => {
		const refreshSchema = vi.fn();
		useSchemaCache.setState({ refreshSchema });
		useExplorerStore.setState({ open: false });
		mount("");

		fireEvent.click(screen.getByLabelText("Refresh schema"));

		// Mutation check: point the header at a second copy of the introspection
		// call and the target assertion breaks.
		expect(refreshSchema).toHaveBeenCalledWith(TARGET);
		// Refreshing is not browsing: the blind refresh #507 is about must not
		// cost the pane opening on top of it.
		expect(screen.queryByTestId("graphql-explorer")).toBeNull();
	});

	it("spins and refuses a second click while a refresh is in flight", () => {
		const refreshSchema = vi.fn();
		const key = schemaCacheKey(TARGET);
		useSchemaCache.setState({
			byKey: { [key]: { status: "loading", schema: null, error: null, fetchedAt: null } },
			refreshSchema,
		});
		useExplorerStore.setState({ open: false });
		mount("");

		const refresh = screen.getByLabelText("Refresh schema");
		expect(refresh).toBeDisabled();
		expect(refresh.querySelector(".animate-spin")).toBeTruthy();
		fireEvent.click(refresh);
		expect(refreshSchema).not.toHaveBeenCalled();
	});
});

describe("inserting into the document", () => {
	it("writes a runnable operation into the query pane", () => {
		const view = mount("");
		insert("Query", "user");

		expect(view.query()).toContain("query User($id: ID!)");
		expect(view.query()).toContain("user(id: $id)");
	});

	it("writes the query and the variables in one body update", () => {
		const view = mount("");
		insert("Query", "user");

		// One write, carrying both - two would each re-serialise from the
		// envelope and the second would undo the first's variables.
		expect(view.bodies).toHaveLength(1);
		const parts = parseGraphQLBody(view.lastBody());
		expect(parts.query).toContain("user(id: $id)");
		expect(JSON.parse(parts.variables)).toEqual({ id: "" });
	});

	it("places the caret inside the new selection set, against the new text", () => {
		const view = mount("");
		insert("Query", "user");

		const caret = positions.get("graphql")!;
		const offset = offsetAt(view.query(), caret);
		const head = view.query().slice(0, offset);
		// More opening braces than closing ones behind the caret means it is
		// inside a selection set. Computed against the inserted document, which
		// is the part that only works because the caret waited for it.
		expect(head.split("{").length).toBeGreaterThan(head.split("}").length);
	});

	it("adds to the operation the caret is in instead of starting another", () => {
		const body = JSON.stringify({
			query: `query Existing {\n  user(id: "1") {\n    id\n  }\n}\n`,
		});
		const view = mount(body);
		// The caret inside the operation's selection set - line 2 is `user(...`.
		positions.set("graphql", { lineNumber: 2, column: 3 });
		insert("Query", "search");

		expect(view.query().match(/query /g)).toHaveLength(1);
		expect(view.query()).toContain("search(term: $term)");
	});

	it("starts a new operation when the caret is in no selection set at all", () => {
		const body = JSON.stringify({
			query: `query Existing {\n  user(id: "1") {\n    id\n  }\n}\n`,
		});
		const view = mount(body);
		// Column 1 of line 1 is before the operation's `{` - outside everything.
		positions.set("graphql", { lineNumber: 1, column: 1 });
		insert("Query", "search");

		expect(view.query().match(/query /g)).toHaveLength(2);
		expect(view.query()).toContain("query Existing");
	});
});

describe("the Variables pane", () => {
	it("merges into strict JSON without disturbing a value already there", () => {
		const body = JSON.stringify({ query: "", variables: { id: "42" } });
		const view = mount(body);
		insert("Query", "user");

		expect(JSON.parse(view.variables())).toEqual({ id: "42" });
	});

	it("never rewrites a templated draft, and says what it could not write", () => {
		const draft = '{"id": {{userId}}}';
		const body = JSON.stringify({ query: "", variables: draft });
		const view = mount(body);
		insert("Query", "search");

		// Mutation check: drop the strict-JSON guard in `mergeVariables` and this
		// pane is replaced by `{"term": ""}` - the user's working template gone.
		expect(view.variables()).toBe(draft);
		expect(screen.getByTitle(/not plain JSON/).textContent).toContain(
			"1 variable needs a value"
		);
	});

	it("opens itself when an insertion leaves variables needing a value", () => {
		useLayoutStore.setState({ graphqlVariablesCollapsed: true });
		const body = JSON.stringify({ query: "", variables: '{"id": {{userId}}}' });
		mount(body);
		insert("Query", "search");

		// The badge names variables the user now has to type values into, and
		// typing needs the editor - the one moment the badge alone is not enough.
		expect(useLayoutStore.getState().graphqlVariablesCollapsed).toBe(false);
		expect(screen.getByTitle(/not plain JSON/)).toBeTruthy();
	});

	it("stays collapsed for an insertion that wrote its variables", () => {
		useLayoutStore.setState({ graphqlVariablesCollapsed: true });
		mount("");
		insert("Query", "user");

		// `{}` merges cleanly, so nothing is pending and nothing demands the
		// pane - a collapse the user chose is not undone by every click.
		expect(useLayoutStore.getState().graphqlVariablesCollapsed).toBe(true);
	});

	it("drops the badge once the user has touched the pane", () => {
		const body = JSON.stringify({ query: "", variables: '{"id": {{userId}}}' });
		mount(body);
		insert("Query", "search");
		expect(screen.getByTitle(/not plain JSON/)).toBeTruthy();

		act(() => {
			fireEvent.click(screen.getByTestId("editor-json"));
		});
		expect(screen.queryByTitle(/not plain JSON/)).toBeNull();
	});
});

describe("what the pane says out loud", () => {
	it("announces an insertion and where it landed", () => {
		const view = mount("");
		insert("Query", "user");
		expect(view.announcement()).toBe("Inserted query User as a new operation.");
	});

	it("names the variables it could not write into the pane", () => {
		const body = JSON.stringify({ query: "", variables: '{"id": {{userId}}}' });
		const view = mount(body);
		insert("Query", "search");
		expect(view.announcement()).toContain("1 variable needs a value: term.");
	});

	it("refuses a subscription out loud and leaves the document alone", () => {
		const view = mount("");
		insert("Subscription (not executable)", "postAdded");

		expect(view.announcement()).toContain("Subscriptions cannot be run here");
		expect(view.bodies).toHaveLength(0);
	});

	it("refuses an enum value out loud rather than writing something invalid", () => {
		const view = mount("");
		fireEvent.click(rowNamed("Types").querySelector("[data-tree-toggle]")!);
		fireEvent.click(rowNamed("Ranking").querySelector("[data-tree-toggle]")!);
		act(() => {
			fireEvent.click(rowNamed("RELEVANCE").querySelector("[data-tree-activate]")!);
		});

		expect(view.announcement()).toContain("part of an argument");
		expect(view.bodies).toHaveLength(0);
	});

	it("shows a leaf that is already selected instead of adding it twice", () => {
		const body = JSON.stringify({
			query: `query Existing {\n  user(id: "1") {\n    id\n    handle\n  }\n}\n`,
		});
		const view = mount(body);
		positions.set("graphql", { lineNumber: 4, column: 5 });

		fireEvent.click(rowNamed("Query").querySelector("[data-tree-toggle]")!);
		fireEvent.click(rowNamed("user").querySelector("[data-tree-toggle]")!);
		act(() => {
			fireEvent.click(rowNamed("handle").querySelector("[data-tree-activate]")!);
		});

		// Mutation check: drop the already-present branch and the document grows
		// a second `handle` line the user cannot tell from the first.
		expect(view.bodies).toHaveLength(0);
		expect(view.announcement()).toBe("handle is already selected.");
		// Selected rather than merely scrolled to: the editor's own selection is
		// what marks the line, so there is no second highlight to maintain.
		expect(selections.get("graphql")).toEqual({
			startLineNumber: 4,
			startColumn: 5,
			endLineNumber: 4,
			endColumn: 11,
		});
		expect(reveals.get("graphql")).toEqual([4]);
	});

	it("inserts a type as the operation that returns it, not a fragment", () => {
		const view = mount("");
		fireEvent.click(rowNamed("Types").querySelector("[data-tree-toggle]")!);
		act(() => {
			fireEvent.click(rowNamed("Post").querySelector("[data-tree-activate]")!);
		});

		/*
		 * Mutation check: route a type row back to `insertFragment` and the
		 * document is `fragment PostFields on Post { … }` and nothing else - it
		 * parses, holds no operation, and Send gets nothing back.
		 */
		expect(view.query()).toContain("createPost(input: $input)");
		expect(view.query()).not.toContain("fragment");
		expect(view.announcement()).toContain("as a new operation");
	});

	it("shows a refusal in the pane, not only to a screen reader", () => {
		const view = mount("");
		insert("Subscription (not executable)", "postAdded");

		// The live region still says it; the point is that a sighted user now
		// sees why the click did nothing.
		const notice = screen.getByTestId("explorer-notice");
		expect(notice.textContent).toContain("Subscriptions cannot be run here");
		expect(view.announcement()).toContain("Subscriptions cannot be run here");
	});

	it("clears the refusal once an insertion lands, so it answers this click", () => {
		mount("");
		insert("Subscription (not executable)", "postAdded");
		expect(screen.queryByTestId("explorer-notice")).not.toBeNull();

		insert("Query", "user");
		expect(screen.queryByTestId("explorer-notice")).toBeNull();
	});
});

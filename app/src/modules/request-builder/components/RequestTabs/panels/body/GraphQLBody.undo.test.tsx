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
 * The GraphQL query and variables panes keep undo inside their request (#3136),
 * for the reason `BodyPanel.undo.test.tsx` holds for the raw body: one pane
 * serves every request tab, and a changed `value` is an undoable edit on the
 * model in hand. Real editor core, no stub (`real-monaco.testkit.ts`).
 *
 * The variables pane has a second way to leak: its text lives in state that is
 * re-seeded after a request switch, so a model keyed by request but handed the
 * previous request's text for one render would be created holding it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useSchemaCache, type SchemaTarget } from "@/lib/graphql/schema-cache";
import { useLayoutStore } from "@/stores";
import { ownVariablesDraft, type VariablesDraft } from "../../../../utils/body-drafts";
import { realMonaco, typeInto, undo } from "@/test/real-monaco.testkit";

vi.mock("@/lib/monaco-loader", async () =>
	(await import("@/test/real-monaco.testkit")).realMonacoLoader()
);

const { GraphQLBody } = await import("./GraphQLBody");
const monaco = await realMonaco();

const TARGET: SchemaTarget = { url: "" } as unknown as SchemaTarget;

const BODIES: Record<string, string> = {
	A: '{"query":"query A { a }","variables":{"a":1}}',
	B: '{"query":"query B { b }","variables":{"b":2}}',
};

/** Every body the pane wrote back, in order. */
let written: string[] = [];

function Builder() {
	const [id, setId] = useState("A");
	const [bodies, setBodies] = useState(BODIES);
	const [draft, setDraft] = useState<VariablesDraft | null>(null);
	return (
		<TooltipProvider>
			<button onClick={() => setId("A")}>go A</button>
			<button onClick={() => setId("B")}>go B</button>
			<GraphQLBody
				body={bodies[id]}
				onBodyChange={(next) => {
					written.push(next);
					setBodies((prev) => ({ ...prev, [id]: next }));
				}}
				requestId={id}
				schemaTarget={TARGET}
				method="POST"
				variablesDraft={ownVariablesDraft(draft, id)}
				onVariablesDraftChange={(text) => setDraft({ requestId: id, text })}
			/>
		</TooltipProvider>
	);
}

type Editor = ReturnType<typeof monaco.editor.getEditors>[number];

/** The pane by its accessible name, which is what tells two JSON-or-GraphQL editors apart. */
function pane(label: "GraphQL query" | "GraphQL variables"): Editor {
	const found = monaco.editor.getEditors().find((e) => e.getRawOptions().ariaLabel === label);
	if (!found) throw new Error(`no ${label} editor`);
	return found;
}

async function mountedPanes() {
	render(<Builder />);
	await waitFor(() => expect(monaco.editor.getEditors()).toHaveLength(2));
	await waitFor(() => expect(screen.queryAllByText("Loading...")).toHaveLength(0));
}

function typeAtEnd(editor: Editor, text: string) {
	const model = editor.getModel();
	if (!model) throw new Error("no model");
	editor.setPosition(model.getFullModelRange().getEndPosition());
	act(() => typeInto(editor, text));
}

function goTo(id: "A" | "B") {
	act(() => fireEvent.click(screen.getByRole("button", { name: `go ${id}` })));
}

beforeEach(() => {
	written = [];
	useSchemaCache.setState({ byKey: {}, lru: [], activeKey: null });
	useLayoutStore.setState({ graphqlVariablesCollapsed: false, graphqlVariablesSize: 35 });
});
afterEach(() => {
	cleanup();
	monaco.editor.getModels().forEach((m) => m.dispose());
});

describe("undo across request tabs", () => {
	it("leaves the new request's query alone and writes nothing", async () => {
		await mountedPanes();
		goTo("B");
		expect(pane("GraphQL query").getValue()).toBe("query B { b }");

		act(() => undo(pane("GraphQL query")));

		expect(pane("GraphQL query").getValue()).toBe("query B { b }");
		expect(written).toEqual([]);
	});

	it("leaves the new request's variables alone and writes nothing", async () => {
		await mountedPanes();
		goTo("B");
		expect(JSON.parse(pane("GraphQL variables").getValue())).toEqual({ b: 2 });

		act(() => undo(pane("GraphQL variables")));

		expect(JSON.parse(pane("GraphQL variables").getValue())).toEqual({ b: 2 });
		expect(written).toEqual([]);
	});

	it("undoes a query edit in the request it was typed in, after a round trip", async () => {
		await mountedPanes();
		typeAtEnd(pane("GraphQL query"), " ");
		expect(pane("GraphQL query").getValue()).toBe("query A { a } ");

		goTo("B");
		goTo("A");
		act(() => undo(pane("GraphQL query")));

		expect(pane("GraphQL query").getValue()).toBe("query A { a }");
	});

	it("files each pane of each request under a model of its own", async () => {
		await mountedPanes();
		goTo("B");
		const uris = monaco.editor
			.getModels()
			.map((m) => m.uri.toString())
			.filter((uri) => !uri.includes("vayu-masked"));
		expect(uris.sort()).toEqual([
			"inmemory://request/A/graphql-query",
			"inmemory://request/A/graphql-variables",
			"inmemory://request/B/graphql-query",
			"inmemory://request/B/graphql-variables",
		]);
	});
});

describe("the variables pane's diagnostics", () => {
	it("follow the pane to the next request's model", async () => {
		await mountedPanes();
		const twins = () =>
			monaco.editor
				.getModels()
				.map((m) => m.uri.toString())
				.filter((uri) => uri.includes("vayu-masked"));
		expect(twins()).toEqual(["inmemory://request/A/graphql-variables.vayu-masked.json"]);

		goTo("B");

		expect(twins()).toEqual(["inmemory://request/B/graphql-variables.vayu-masked.json"]);
	});
});

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
 * Undo stays inside the request it was typed in (#3136).
 *
 * One builder serves every request tab and this panel stays mounted once
 * visited (#1718), so one Monaco editor outlives the switch. A changed `value`
 * is an undoable edit on the model in hand: with a model shared across
 * requests, Ctrl+Z in B restored A's text and handed it to `onChange`, which
 * marks B dirty and autosaves A's body into it.
 *
 * These run the real editor core (`real-monaco.testkit.ts`) because the defect
 * is what Monaco does with an undo stack, which no stub of it can answer. The
 * GraphQL panes are held in `body/GraphQLBody.undo.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { emptyDrafts } from "../../../utils/body-drafts";
import { fieldResolverOf } from "@/test/variable-support";
import { realMonaco, typeInto, undo } from "@/test/real-monaco.testkit";

vi.mock("@/lib/monaco-loader", async () =>
	(await import("@/test/real-monaco.testkit")).realMonacoLoader()
);
vi.mock("./body/GraphQLBody", () => ({ default: () => <div data-testid="graphql-body" /> }));
vi.mock("@/services/api", () => ({ apiService: { getRequest: vi.fn() } }));

const { default: BodyPanel } = await import("./BodyPanel");
const monaco = await realMonaco();

/** Every body the panel reported through `updateField`, in order. */
let reported: string[] = [];

/** Two requests behind one panel, switched by buttons the way a tab click would. */
function Builder() {
	const [bodies, setBodies] = useState<Record<string, string>>({ A: "aaa", B: "bbb" });
	const [id, setId] = useState("A");
	const [bodyMode, setBodyMode] = useState("json");
	// The GraphQL envelope is its own bucket (`utils/body-drafts.ts`): leaving for
	// it shows its text, and coming back restores the raw one.
	const body = bodyMode === "graphql" ? '{"query":"{ a }"}' : bodies[id];
	const value = {
		request: { ...createDefaultRequestState(), id, bodyMode, body },
		updateField: (field: string, next: string) => {
			if (field === "bodyMode") setBodyMode(next);
			if (field !== "body" || bodyMode === "graphql") return;
			reported.push(next);
			setBodies((prev) => ({ ...prev, [id]: next }));
		},
		setRequest: () => {},
		getBodyDrafts: () => emptyDrafts(id),
		setBodyDrafts: () => {},
		getVariablesDraft: () => null,
		setVariablesDraft: () => {},
		resolveString: (s: string) => s,
		resolveField: fieldResolverOf((s: string) => s),
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		writableScopes: [],
		updateVariable: () => {},
	} as unknown as RequestBuilderContextValue;
	return (
		<RequestBuilderContext.Provider value={value}>
			<button onClick={() => setId("A")}>go A</button>
			<button onClick={() => setId("B")}>go B</button>
			<button onClick={() => setBodyMode("xml")}>mode xml</button>
			<button onClick={() => setBodyMode("graphql")}>mode graphql</button>
			<button onClick={() => setBodyMode("json")}>mode json</button>
			<BodyPanel />
		</RequestBuilderContext.Provider>
	);
}

async function mountedEditor() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<Builder />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await waitFor(() => expect(monaco.editor.getEditors()).toHaveLength(1));
	// The editor exists a render before it is wired to `onChange`; the library's
	// loading text is what leaves once that render has happened.
	await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
	return monaco.editor.getEditors()[0];
}

/** Type at the end of the text, as a user clicking after the last character would. */
function typeAtEnd(editor: ReturnType<typeof monaco.editor.getEditors>[number], text: string) {
	const model = editor.getModel();
	if (!model) throw new Error("no model");
	editor.setPosition(model.getFullModelRange().getEndPosition());
	act(() => typeInto(editor, text));
}

function goTo(id: "A" | "B") {
	act(() => fireEvent.click(screen.getByRole("button", { name: `go ${id}` })));
}

function setMode(mode: "xml" | "graphql" | "json") {
	act(() => fireEvent.click(screen.getByRole("button", { name: `mode ${mode}` })));
}

beforeEach(() => {
	reported = [];
});
afterEach(() => {
	cleanup();
	monaco.editor.getModels().forEach((m) => m.dispose());
});

describe("undo across request tabs", () => {
	it("leaves the new request's body alone and reports nothing", async () => {
		const editor = await mountedEditor();
		goTo("B");
		expect(editor.getValue()).toBe("bbb");

		act(() => undo(editor));

		expect(editor.getValue()).toBe("bbb");
		expect(reported).toEqual([]);
	});

	it("undoes an edit in the request it was typed in, after a round trip", async () => {
		const editor = await mountedEditor();
		typeAtEnd(editor, "!");
		expect(reported).toEqual(["aaa!"]);

		goTo("B");
		goTo("A");
		expect(editor.getValue()).toBe("aaa!");

		act(() => undo(editor));
		expect(editor.getValue()).toBe("aaa");
		expect(reported).toEqual(["aaa!", "aaa"]);
	});

	it("keeps an edit made in B out of A's undo stack", async () => {
		const editor = await mountedEditor();
		goTo("B");
		typeAtEnd(editor, "?");
		goTo("A");

		act(() => undo(editor));

		expect(editor.getValue()).toBe("aaa");
		expect(reported).toEqual(["bbb?"]);
	});

	it("files each request's body under a model of its own", async () => {
		await mountedEditor();
		goTo("B");
		const uris = monaco.editor.getModels().map((m) => m.uri.toString());
		expect(uris.sort()).toEqual(["inmemory://request/A/body", "inmemory://request/B/body"]);
	});
});

describe("undo across a body mode switch", () => {
	it("is one step for the edit, not one for the mode", async () => {
		const editor = await mountedEditor();
		typeAtEnd(editor, "!");
		setMode("xml");
		expect(editor.getValue()).toBe("aaa!");

		act(() => undo(editor));

		expect(editor.getValue()).toBe("aaa");
		expect(reported).toEqual(["aaa!", "aaa"]);
	});

	it("never offers the other mode's text as an undo step", async () => {
		await mountedEditor();
		setMode("graphql");
		expect(await screen.findByTestId("graphql-body")).toBeInTheDocument();
		setMode("json");
		await waitFor(() => expect(monaco.editor.getEditors()).toHaveLength(1));
		const editor = monaco.editor.getEditors()[0];
		await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
		expect(editor.getValue()).toBe("aaa");

		act(() => undo(editor));

		expect(editor.getValue()).toBe("aaa");
		expect(reported).toEqual([]);
	});
});

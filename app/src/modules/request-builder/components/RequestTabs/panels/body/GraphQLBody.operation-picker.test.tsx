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
 * `operationName` end to end through the panes, plus the picker that sets it.
 *
 * `graphql-body.test.ts` pins the converter pair; this pins the thing the user
 * actually did. The bug was a *keystroke*: the query pane's `onChange` wrote a
 * body rebuilt from two fields, so an imported multi-operation request lost its
 * `operationName` on the first character typed and silently began executing
 * whichever operation the server chose. That path only exists inside this
 * component, so only a render can hold it.
 *
 * The editors are mocked down to their `onChange`, which is what makes the
 * keystroke drivable. The picker is asserted by its presence and its accessible
 * name rather than by opening it - Radix Select does not commit a value in
 * jsdom (the same reason `content-type.ts` keeps its rule outside the click
 * handler), and what is worth guarding here is *when* the control appears, not
 * that Radix works.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { SchemaTarget } from "@/lib/graphql/schema-cache";

/** The `onChange` of each mocked editor, by the language it mounted with. */
const editors = new Map<string, (value: string) => void>();

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({
		language,
		value,
		onChange,
	}: {
		language: string;
		value: string;
		onChange: (v: string) => void;
	}) => {
		editors.set(language, onChange);
		return <div data-testid={`editor-${language}`}>{value}</div>;
	},
}));

const { GraphQLBody } = await import("./GraphQLBody");

const TARGET: SchemaTarget = {
	url: "",
} as unknown as SchemaTarget;

/** Render the panes over `body` and return the last body they wrote. */
function renderBody(body: string) {
	const onBodyChange = vi.fn();
	render(
		<TooltipProvider>
			<GraphQLBody
				body={body}
				onBodyChange={onBodyChange}
				requestId="r1"
				schemaTarget={TARGET}
				method="POST"
				variablesDraft={null}
				onVariablesDraftChange={() => {}}
			/>
		</TooltipProvider>
	);
	return {
		// `act` so the state a keystroke sets is flushed before the next one reads
		// it - the variables pane holds its text in component state, and a second
		// keystroke against a stale render would test the harness, not the panes.
		typeQuery: (next: string) => act(() => editors.get("graphql")?.(next)),
		typeVariables: (next: string) => act(() => editors.get("json")?.(next)),
		written: () => {
			const calls = onBodyChange.mock.calls;
			return JSON.parse(calls[calls.length - 1]?.[0] ?? "null") as Record<string, unknown>;
		},
		onBodyChange,
	};
}

const MULTI = JSON.stringify({
	query: "query A { a } query B { b }",
	operationName: "B",
});

beforeEach(() => {
	editors.clear();
});

describe("editing an imported multi-operation request", () => {
	// The reported bug. Mutation check: rebuild the body from `query` and
	// `variables` alone in `write` and this reddens.
	it("keeps operationName through a keystroke in the query pane", () => {
		const pane = renderBody(MULTI);
		pane.typeQuery("query A { a } query B { b2 }");

		expect(pane.written()).toEqual({
			query: "query A { a } query B { b2 }",
			operationName: "B",
		});
	});

	it("keeps operationName through a keystroke in the variables pane", () => {
		const pane = renderBody(MULTI);
		pane.typeVariables('{"n": 1}');

		expect(pane.written()).toEqual({
			query: "query A { a } query B { b }",
			operationName: "B",
			variables: { n: 1 },
		});
	});

	// The panes are two editors over one envelope, so a variables draft must not
	// be undone by the next keystroke in the query pane.
	it("carries the variables draft into a later query edit", () => {
		const pane = renderBody(MULTI);
		pane.typeVariables('{"n": 1}');
		pane.typeQuery("query A { a } query B { b3 }");

		expect(pane.written()).toEqual({
			query: "query A { a } query B { b3 }",
			operationName: "B",
			variables: { n: 1 },
		});
	});

	it("keeps envelope keys the editor does not model", () => {
		const pane = renderBody(JSON.stringify({ query: "{ me }", extensions: { trace: "on" } }));
		pane.typeQuery("{ you }");

		expect(pane.written()).toEqual({ query: "{ you }", extensions: { trace: "on" } });
	});
});

describe("the operation picker", () => {
	it("appears when the document defines more than one operation", () => {
		renderBody(MULTI);
		expect(screen.getByLabelText("Operation")).toBeTruthy();
	});

	it.each([
		["a single named operation", JSON.stringify({ query: "query B { b }" })],
		["an anonymous operation", JSON.stringify({ query: "{ me }" })],
		["a document that does not parse", JSON.stringify({ query: "query B {" })],
		["an empty body", ""],
	])("stays out of the way for %s", (_label, body) => {
		renderBody(body);
		expect(screen.queryByLabelText("Operation")).toBeNull();
	});

	// Renaming the operation in the pane must not silently rewrite the envelope:
	// what will be sent is still `B`, so the control keeps offering it.
	it("does not rewrite operationName when the document stops defining it", () => {
		const pane = renderBody(MULTI);
		pane.typeQuery("query A { a } query C { c }");

		expect(pane.written().operationName).toBe("B");
	});
});

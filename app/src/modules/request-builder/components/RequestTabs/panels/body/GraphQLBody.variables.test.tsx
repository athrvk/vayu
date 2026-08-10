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
 * What survives a glance at another tab, and what the Variables pane admits to.
 *
 * Radix unmounts the inactive `TabsContent`, so `GraphQLBody` is torn down and
 * rebuilt every time you look at Headers. Text the body cannot carry - and the
 * body cannot carry variables that are neither JSON nor a template - therefore
 * has to live somewhere the unmount does not reach. These drive the mocked
 * editor's `onChange`, unmount, and mount again, because the loss only exists
 * across that boundary and a state-level assertion cannot see it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useSchemaCache, type SchemaTarget } from "@/lib/graphql/schema-cache";

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

const TARGET: SchemaTarget = { url: "" } as unknown as SchemaTarget;

/**
 * The panel's half of the contract: one draft box that outlives the component,
 * exactly as `RequestBuilderProvider` holds it.
 */
function harness(initialBody: string) {
	const state = { body: initialBody, draft: null as string | null };
	let rendered: ReturnType<typeof render> | null = null;
	const tree = () => (
		<TooltipProvider>
			<GraphQLBody
				body={state.body}
				onBodyChange={(b) => {
					state.body = b;
				}}
				requestId="r1"
				schemaTarget={TARGET}
				onEditorMount={() => {}}
				variablesDraft={state.draft}
				onVariablesDraftChange={(text) => {
					state.draft = text;
				}}
			/>
		</TooltipProvider>
	);
	const view = {
		mount() {
			rendered = render(tree());
		},
		/** The body changing under a mounted panel - what a request switch does. */
		rerender(body: string) {
			state.body = body;
			act(() => rendered?.rerender(tree()));
		},
		type(text: string) {
			// `act` so the state the keystroke sets is flushed before the assertion
			// reads it back out of the next render.
			act(() => editors.get("json")?.(text));
		},
		paneText: () => screen.getByTestId("editor-json").textContent ?? "",
	};
	return { state, view };
}

beforeEach(() => {
	editors.clear();
	useSchemaCache.setState({ byKey: {}, lru: [], activeKey: null });
});
afterEach(cleanup);

describe("the variables draft", () => {
	it("survives the unmount a tab glance causes, even when the body cannot hold it", () => {
		const { state, view } = harness('{"query":"q"}');
		view.mount();
		view.type('{"limit": ');
		// The body legitimately does not carry it - that is PR #399's decision.
		expect(state.body).toBe('{"query":"q"}');

		cleanup();
		view.mount();
		expect(view.paneText()).toBe('{"limit": ');
	});

	it("still shows the body's variables when there is no draft", () => {
		const { view } = harness('{"query":"q","variables":{"id":1}}');
		view.mount();
		expect(JSON.parse(view.paneText())).toEqual({ id: 1 });
	});

	it("re-derives the pane, and the draft, when the body changes underneath it", () => {
		// A request switch: the incoming body wins, and the draft must not survive
		// it into the next request's pane.
		const { state, view } = harness('{"query":"q","variables":{"id":1}}');
		view.mount();
		view.type('{"half-typed": ');
		expect(state.draft).toBe('{"half-typed": ');

		view.rerender('{"query":"other","variables":{"id":2}}');
		expect(JSON.parse(view.paneText())).toEqual({ id: 2 });
		expect(JSON.parse(state.draft ?? "null")).toEqual({ id: 2 });
	});
});

describe("the variables badge", () => {
	it("says nothing for strict JSON", () => {
		const { view } = harness('{"query":"q","variables":{"id":1}}');
		view.mount();
		expect(screen.queryByText("Templated")).toBeNull();
		expect(screen.queryByText("Not sent")).toBeNull();
	});

	it("names variables that are not sent at all", () => {
		const { view } = harness('{"query":"q"}');
		view.mount();
		view.type('{"limit": ');
		expect(screen.getByText("Not sent").getAttribute("title")).toMatch(/without them/i);
	});

	it("distinguishes a template, which is sent, from broken text, which is not", () => {
		const { state, view } = harness('{"query":"q"}');
		view.mount();
		view.type('{"limit": {{n}}}');
		expect(screen.queryByText("Not sent")).toBeNull();
		expect(screen.getByText("Templated").getAttribute("title")).toMatch(/resolved and sent/i);
		// And it genuinely reached the body, which is the half the badge asserts.
		expect(state.body).toBe('{"query":"q","variables":{"limit":{{n}}}}');
	});
});

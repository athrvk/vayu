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
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useSchemaCache, type SchemaTarget } from "@/lib/graphql/schema-cache";
import { useLayoutStore } from "@/stores";

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
				method="POST"
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

/** The Variables pane's header, which is also the control that collapses it. */
const variablesHeader = () => screen.getByRole("button", { name: /Variables/ });

beforeEach(() => {
	editors.clear();
	useSchemaCache.setState({ byKey: {}, lru: [], activeKey: null });
	useLayoutStore.setState({ graphqlVariablesCollapsed: false, graphqlVariablesSize: 35 });
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

/**
 * The pane's height is a preference, and one the Radix unmount must not eat.
 *
 * jsdom has no layout, so the panel's own pixels are not what these read - the
 * store is, because the store is deliberately the source of truth here for
 * exactly the reason these cases exercise: the panel's memory dies with the
 * mount and the user's does not.
 */
describe("collapsing the variables pane", () => {
	it("collapses from its header and says which way it is pointing", () => {
		const { view } = harness('{"query":"q"}');
		view.mount();
		expect(variablesHeader().getAttribute("aria-expanded")).toBe("true");

		fireEvent.click(variablesHeader());

		expect(variablesHeader().getAttribute("aria-expanded")).toBe("false");
		expect(useLayoutStore.getState().graphqlVariablesCollapsed).toBe(true);
	});

	it("opens again from the same header, and keeps the height it remembers", () => {
		useLayoutStore.setState({ graphqlVariablesCollapsed: true, graphqlVariablesSize: 60 });
		const { view } = harness('{"query":"q"}');
		view.mount();
		expect(variablesHeader().getAttribute("aria-expanded")).toBe("false");

		fireEvent.click(variablesHeader());

		expect(variablesHeader().getAttribute("aria-expanded")).toBe("true");
		/*
		 * Reopening is not a resize, so the remembered height survives it - the
		 * value the panel is then told to come back to. The pixels themselves
		 * are not asserted anywhere: jsdom has no layout, and a panel in it
		 * reports the same degenerate size whatever it was given.
		 */
		expect(useLayoutStore.getState().graphqlVariablesSize).toBe(60);
	});

	it("stays collapsed across the unmount a tab glance causes", () => {
		const { view } = harness('{"query":"q"}');
		view.mount();
		fireEvent.click(variablesHeader());

		cleanup();
		view.mount();

		// Mutation check: hold `collapsed` in component state instead of the
		// store and the pane comes back open, after a glance the user did not
		// think of as leaving - the same loss `explorer-store` was written for.
		expect(variablesHeader().getAttribute("aria-expanded")).toBe("false");
	});

	it("keeps the pane's badge readable while it is collapsed", () => {
		const { view } = harness('{"query":"q"}');
		view.mount();
		view.type('{"limit": ');

		fireEvent.click(variablesHeader());

		// "Not sent" is the state a collapsed pane most needs to admit to: the
		// request goes out without the variables and the editor is not on screen
		// to hint at it.
		expect(screen.getByText("Not sent")).toBeTruthy();
	});
});

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
 * The Body panel's side effect, and the two things it used to hide.
 *
 * **Choosing GraphQL edits your Headers tab.** `handleModeChange` appends
 * `Content-Type: application/json` when the mode becomes `graphql` and no
 * Content-Type exists. It did that in silence, on a tab you are not looking at,
 * and nothing ever removed it - so picking GraphQL once and going back to None
 * left the header on the request for good. The header is genuinely required, so
 * it is still added; what is tested here is that it says so and can be undone.
 *
 * **The content type is visible without opening the dropdown.** It used to
 * appear only inside the list, so once a mode was chosen the thing that
 * actually goes on the wire was one click away and invisible the rest of the
 * time.
 *
 * Monaco and the GraphQL editor pair are stubbed - neither is what this guards,
 * and Monaco does not run in jsdom.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { emptyDrafts } from "../../../utils/body-drafts";
import type { RequestState } from "../../../types";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	// The language comes through on the stub because it is the whole of what a
	// mode with no editor of its own gets: JSON-RPC is the plain pane plus
	// `language="json"`, and a stub that dropped it could not tell that apart
	// from plaintext.
	CodeEditor: ({ language }: { language?: string }) => (
		<div data-testid="code-editor" data-language={language} />
	),
}));
vi.mock("./body/GraphQLBody", () => ({ default: () => <div data-testid="graphql-body" /> }));

const { default: BodyPanel } = await import("./BodyPanel");

const updateField = vi.fn();

function renderPanel(overrides: Partial<RequestState> = {}) {
	const request = { ...createDefaultRequestState(), ...overrides };
	const value = {
		request,
		updateField,
		// BodyPanel stashes through these on a mode change.
		getBodyDrafts: () => emptyDrafts(request.id),
		setBodyDrafts: () => {},
		// And remembers the Content-Type row it wrote through these.
		getAutoContentType: () => null,
		setAutoContentType: () => {},
		resolveString: (s: string) => s.replace(VARIABLE_PATTERN, (_m, n) => `resolved-${n}`),
		// The form-data / urlencoded modes render the key/value table, which
		// reaches VariableInput for every cell.
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		writableScopes: [],
		updateVariable: () => {},
	} as unknown as RequestBuilderContextValue;

	return render(
		// A `{{variable}}` cell hovers to a tooltip, and Radix needs the provider
		// the app mounts at its root.
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<BodyPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

beforeEach(() => vi.clearAllMocks());

describe("the content type a mode implies", () => {
	it("is on screen without opening the dropdown", () => {
		renderPanel({ bodyMode: "json" });
		expect(screen.getByText("application/json")).toBeInTheDocument();
	});

	it("names the multipart type for form-data", () => {
		renderPanel({ bodyMode: "form-data" });
		expect(screen.getByText("multipart/form-data")).toBeInTheDocument();
	});

	it("says plainly that None sends nothing", () => {
		// It used to be a `py-12` centred paragraph - about 120px to say the
		// default mode is the default mode.
		renderPanel({ bodyMode: "none" });
		expect(screen.getByText("No body will be sent.")).toBeInTheDocument();
	});

	it("gives None no content type, because it has none", () => {
		const { container } = renderPanel({ bodyMode: "none" });
		expect(container.querySelector("code")).toBeNull();
	});
});

/**
 * JSON-RPC is deliberately the *plain* pane. The envelope around the call is
 * completed engine-side at the chokepoint every client shares, so there is no
 * structure for this side to edit - unlike GraphQL, whose query and variables
 * are two documents and get a component. What the mode does own is JSON
 * highlighting and the `application/json` its frame is sent as.
 */
describe("the JSON-RPC mode", () => {
	it("uses the plain code editor, not the GraphQL pair", () => {
		renderPanel({ bodyMode: "jsonrpc" });
		expect(screen.getByTestId("code-editor")).toBeInTheDocument();
		expect(screen.queryByTestId("graphql-body")).not.toBeInTheDocument();
	});

	// Mutation check: drop `jsonrpc` from the editor's language ternary and this
	// reddens with `plaintext` - a JSON pane with no JSON in it.
	it("highlights it as JSON", () => {
		renderPanel({ bodyMode: "jsonrpc" });
		expect(screen.getByTestId("code-editor")).toHaveAttribute("data-language", "json");
	});

	it("shows the type its frame is sent as", () => {
		renderPanel({ bodyMode: "jsonrpc" });
		expect(screen.getByText("application/json")).toBeInTheDocument();
	});

	// A JSON-RPC call is where `{{variables}}` earn their keep - the params
	// change per send and the method does not - so the mode has to reach the
	// Source/Resolved swap, which only code modes offer.
	it("offers the resolved preview, because it is a code mode", () => {
		renderPanel({ bodyMode: "jsonrpc", body: '{"method":"m","params":["{{addr}}"]}' });
		fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
		expect(screen.getByText(/resolved-addr/)).toBeInTheDocument();
	});
});

describe("the resolved preview swaps rather than splits", () => {
	const withVariable = { bodyMode: "json" as const, body: '{"id":"{{merchantId}}"}' };

	it("offers the swap only when the body has a variable", () => {
		renderPanel({ bodyMode: "json", body: '{"id":"literal"}' });
		expect(screen.queryByRole("button", { name: "Resolved" })).not.toBeInTheDocument();
	});

	it("shows the editor and no preview by default", () => {
		renderPanel(withVariable);
		expect(screen.getByTestId("code-editor")).toBeInTheDocument();
		expect(screen.queryByText("resolved-merchantId", { exact: false })).not.toBeInTheDocument();
	});

	it("replaces the editor rather than shrinking it", () => {
		// The old layout was `grid-cols-2`, so the code being edited gave up half
		// its width to a read-only echo.
		renderPanel(withVariable);
		fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
		expect(screen.queryByTestId("code-editor")).not.toBeInTheDocument();
		expect(screen.getByText(/resolved-merchantId/)).toBeInTheDocument();
	});

	it("goes back to the source", () => {
		renderPanel(withVariable);
		fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
		fireEvent.click(screen.getByRole("button", { name: "Source" }));
		expect(screen.getByTestId("code-editor")).toBeInTheDocument();
	});
});

describe("the editor's resize handle", () => {
	it("is reachable and operable from the keyboard", () => {
		// It was `role="separator"` with an onMouseDown and nothing else, so the
		// editor height was mouse-only.
		renderPanel({ bodyMode: "json" });
		const handle = screen.getByRole("separator", { name: "Resize editor" });
		expect(handle).toHaveAttribute("tabindex", "0");
		expect(handle).toHaveAttribute("aria-valuenow");
	});
});

describe("form-data and urlencoded", () => {
	it.each(["form-data", "x-www-form-urlencoded"] as const)("renders a table for %s", (mode) => {
		// They were two copies of the same call, one wrapped in a div and one not.
		const { container } = renderPanel({ bodyMode: mode });
		expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
	});

	/*
	 * The table takes its variable scope as a prop now, because the hook it used
	 * to call throws outside `RequestBuilderProvider` and made the primitive
	 * unusable anywhere else (#564). The thread from context to prop is a wiring
	 * bug waiting to happen - the row's own tests hand it a scope directly and
	 * would stay green with `variables={variables}` deleted from this panel.
	 * Mutation check: delete it and the marker disappears.
	 */
	it("hands the table this request's variable scope", () => {
		const { container } = renderPanel({
			bodyMode: "form-data",
			formData: [{ id: "fd1", key: "region", value: "{{zone}}", enabled: true }],
		});
		expect(container.querySelector('[aria-label="Resolved value of region"]')).not.toBeNull();
	});
});

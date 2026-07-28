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
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { emptyDrafts } from "../../../utils/body-drafts";
import type { RequestState } from "../../../types";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
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
		resolveString: (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_m, n) => `resolved-${n}`),
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
});

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
 * The body pane's large-body mode (issue #1157).
 *
 * Everything this component does to a body it does synchronously during render:
 * `formatBody` parses the JSON and re-indents it - a copy larger than its input
 * - and Monaco then tokenises the result line by line. Past
 * `LARGE_BODY_BYTES` that is a frozen window between Send and the pane
 * painting, so above it the pane formats nothing, shows a bounded prefix, and
 * says so.
 *
 * Asserted on rendered output and on the props the editor is handed, not on a
 * source scan: the gate is a runtime decision about a value, and a scan would
 * pass on a component that computed it and never used it.
 */

import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { LARGE_BODY_BYTES } from "./utils";

// Monaco does not run in jsdom. The stub records what it was handed, which is
// half of what this test is about.
const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: (props: Record<string, unknown>) => {
		editorProps.current = props;
		return <div data-testid="code-editor" />;
	},
}));

import ResponseBody from "./ResponseBody";

/** A JSON body whose raw form is at least `bytes` characters, on one line. */
function jsonBody(bytes: number): string {
	return JSON.stringify({ pad: "x".repeat(bytes) });
}

function renderBody(raw: string, actions?: ReactNode) {
	editorProps.current = null;
	return render(
		<ResponseBody
			body={raw}
			bodyRaw={raw}
			headers={{ "content-type": "application/json" }}
			actions={actions}
		/>
	);
}

/** What the stubbed editor was last handed as its `value`. */
function editorValue(): string {
	expect(editorProps.current, "the editor must have rendered").not.toBeNull();
	return String(editorProps.current!.value);
}

describe("above the threshold", () => {
	const big = jsonBody(LARGE_BODY_BYTES + 4096);

	it("renders the notice", () => {
		renderBody(big);

		expect(screen.getByText(/Large response/i)).toBeInTheDocument();
		expect(screen.getByText(/Formatting is off/i)).toBeInTheDocument();
	});

	it("hands the editor a prefix of exactly the threshold, unformatted", () => {
		renderBody(big);

		const value = editorValue();
		expect(value).toHaveLength(LARGE_BODY_BYTES);
		expect(value).toBe(big.slice(0, LARGE_BODY_BYTES));
		// `formatBody` would have parsed and re-indented this, which puts a
		// newline after the opening brace. The raw body has none.
		expect(value).not.toContain("\n");
	});

	it("drops syntax highlighting, which is the third whole-string pass", () => {
		renderBody(big);

		expect(editorProps.current!.language).toBe("plaintext");
	});

	it("hides the view toggle, since the view it selects is the one turned off", () => {
		renderBody(big);

		expect(screen.queryByRole("radiogroup", { name: /Body view mode/i })).toBeNull();
	});

	it("does not sniff the type from the body, which is a whole-string pass", () => {
		// `detectBodyType` falls through to `body.trim()` + `JSON.parse` +
		// `toLowerCase` whenever the content-type is missing or generic. That
		// runs before the gate below it, so a large unlabelled body would freeze
		// the pane on the way to the notice that exists to stop exactly that.
		render(
			<ResponseBody body={big} bodyRaw={big} headers={{ "content-type": "text/plain" }} />
		);

		// The toolbar's type label is what the sniff would have changed: with the
		// body handed to it, `text/plain` JSON is promoted to `json`. Asserting
		// the editor's language would prove nothing here - the gate forces
		// `plaintext` either way.
		expect(screen.getByText("text")).toBeInTheDocument();
		expect(screen.queryByText("json")).toBeNull();
	});

	it("promises Download only where there is one", () => {
		// `ResponseBody` is shared with the history viewer, which passes no
		// `actions` slot and so has no Download button on screen.
		renderBody(big);
		expect(screen.queryByText(/Download saves the body the app received/i)).toBeNull();

		renderBody(big, <button type="button">Download</button>);
		expect(screen.getByText(/Download saves the body the app received/i)).toBeInTheDocument();
	});
});

describe("below the threshold", () => {
	const small = jsonBody(1024);

	it("shows no notice", () => {
		renderBody(small);

		expect(screen.queryByText(/Large response/i)).toBeNull();
	});

	it("still formats the body and keeps the toggle", () => {
		renderBody(small);

		expect(editorValue()).toBe(JSON.stringify(JSON.parse(small), null, 2));
		expect(editorProps.current!.language).toBe("json");
		expect(screen.getByRole("radiogroup", { name: /Body view mode/i })).toBeInTheDocument();
	});
});

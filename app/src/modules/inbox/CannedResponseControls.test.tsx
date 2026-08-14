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
 * The canned response panel (issue #556).
 *
 * Two things were wrong with it and they are the same kind of wrong. It showed
 * two of the four fields the engine serves, so a reply body or header set
 * configured by an agent or a bare curl was invisible and uneditable here; and
 * it stayed fully live on a *stopped* inbox, where `PUT /inbox/:id` still
 * merge-patches the record - so the panel accepted edits to a reply nothing
 * would ever send.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useToastStore } from "@/stores";
import type { InboxCannedResponse } from "@/types";
import { CannedResponseControls } from "./CannedResponseControls";

function response(overrides: Partial<InboxCannedResponse> = {}): InboxCannedResponse {
	return { status: 200, body: "", headers: {}, delayMs: 0, ...overrides };
}

/*
 * The reply headers are `KeyValueEditor` rows now, not hand-rolled `Input`
 * pairs (#564) - so they are labelled by the table's placeholders and the table
 * always keeps one trailing blank row to type into, in place of the panel's own
 * "Add header" button.
 */
const headerName = (row: number) => screen.getAllByLabelText("Name")[row];
const headerValue = (row: number) => screen.getAllByLabelText("Value")[row];

/** The message the panel just refused with. */
function lastToastMessage(): string | undefined {
	const { toasts } = useToastStore.getState();
	return toasts[toasts.length - 1]?.message;
}

beforeEach(() => {
	cleanup();
	useToastStore.setState({ toasts: [] });
});

describe("every field the engine serves", () => {
	it("round-trips all four through one apply", () => {
		const onApply = vi.fn();
		render(
			<CannedResponseControls
				// A served body opens the panel: what the inbox answers with is not
				// something the reader should have to go looking for.
				response={response({ body: '{"ok":true}', headers: { "X-Trace": "abc" } })}
				pending={false}
				stopped={false}
				onApply={onApply}
			/>
		);

		expect(screen.getByLabelText("Reply body")).toHaveValue('{"ok":true}');
		expect(headerName(0)).toHaveValue("X-Trace");
		expect(headerValue(0)).toHaveValue("abc");

		fireEvent.change(screen.getByLabelText("Reply status"), { target: { value: "503" } });
		fireEvent.change(screen.getByLabelText("Reply delay (ms)"), { target: { value: "250" } });
		fireEvent.change(screen.getByLabelText("Reply body"), { target: { value: "retry later" } });
		fireEvent.change(headerValue(0), { target: { value: "def" } });
		// The trailing blank row is where a new header is typed - no add button.
		fireEvent.change(headerName(1), { target: { value: "Retry-After" } });
		fireEvent.change(headerValue(1), { target: { value: "5" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		// Whole, not a diff: the route is a merge-patch, so a field left out of
		// the payload keeps the value the inbox is already serving.
		expect(onApply).toHaveBeenCalledWith({
			status: 503,
			delayMs: 250,
			body: "retry later",
			headers: { "X-Trace": "def", "Retry-After": "5" },
		});
	});

	it("sends a removed header as removed, rather than omitting it", () => {
		const onApply = vi.fn();
		render(
			<CannedResponseControls
				response={response({ headers: { "X-Trace": "abc" } })}
				pending={false}
				stopped={false}
				onApply={onApply}
			/>
		);

		fireEvent.click(screen.getAllByLabelText("Remove row")[0]);
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		// An omitted `headers` is what the engine reads as "keep what you have",
		// which is how a deleted header comes back on the next apply.
		expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ headers: {} }));
	});
});

describe("input the engine would refuse", () => {
	const invalid = (field: string, value: string, message: RegExp) => {
		const onApply = vi.fn();
		render(
			<CannedResponseControls
				response={response()}
				pending={false}
				stopped={false}
				onApply={onApply}
			/>
		);
		fireEvent.change(screen.getByLabelText(field), { target: { value } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		expect(onApply).not.toHaveBeenCalled();
		expect(lastToastMessage()).toMatch(message);
		cleanup();
	};

	it("names the field rather than letting a bare 400 come back", () => {
		invalid("Reply status", "999", /between 100 and 599/);
		invalid("Reply delay (ms)", "-1", /between 0 and 30000/);
		// The engine's own rail: the delay holds a listener thread for its whole
		// duration, and the teardown join waits on it.
		invalid("Reply delay (ms)", "60000", /between 0 and 30000/);
	});

	it("refuses a header that would silently go nowhere", () => {
		const onApply = vi.fn();
		render(
			<CannedResponseControls
				response={response({ headers: { "": "" } })}
				pending={false}
				stopped={false}
				onApply={onApply}
			/>
		);

		fireEvent.change(headerValue(0), { target: { value: "v" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(onApply).not.toHaveBeenCalled();
		expect(lastToastMessage()).toMatch(/needs a name/);
	});

	it("refuses one header name set twice, instead of silently keeping the last", () => {
		const onApply = vi.fn();
		render(
			<CannedResponseControls
				response={response({ headers: { "X-Trace": "a" } })}
				pending={false}
				stopped={false}
				onApply={onApply}
			/>
		);

		fireEvent.change(headerName(1), { target: { value: "X-Trace" } });
		fireEvent.change(headerValue(1), { target: { value: "b" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		expect(onApply).not.toHaveBeenCalled();
		expect(lastToastMessage()).toMatch(/set twice/);
	});
});

describe("a stopped inbox", () => {
	/*
	 * Mutation check: drop `stopped` from the `disabled` expression in the
	 * component and every assertion below fails - which is the state the panel
	 * shipped in, offering four live controls over a listener that is gone.
	 */
	it("takes no input and says why", () => {
		render(
			<CannedResponseControls
				response={response({ body: "hi" })}
				pending={false}
				stopped
				onApply={vi.fn()}
			/>
		);

		expect(screen.getByLabelText("Reply status")).toBeDisabled();
		expect(screen.getByLabelText("Reply delay (ms)")).toBeDisabled();
		expect(screen.getByLabelText("Reply body")).toBeDisabled();
		expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
		expect(headerName(0)).toBeDisabled();
		expect(headerValue(0)).toBeDisabled();
		expect(screen.getAllByLabelText("Remove row")[0]).toBeDisabled();
		expect(screen.getByText(/stopped, so nothing is being served/)).toBeInTheDocument();
	});

	it("still reads out what the record holds", () => {
		// Disabled, not hidden: the record survives a stop, and what it would
		// have answered with is the thing a reader came here for.
		render(
			<CannedResponseControls
				response={response({ status: 503, body: "gone", headers: { "X-Trace": "abc" } })}
				pending={false}
				stopped
				onApply={vi.fn()}
			/>
		);

		expect(screen.getByLabelText("Reply status")).toHaveValue("503");
		expect(screen.getByLabelText("Reply body")).toHaveValue("gone");
		expect(headerName(0)).toHaveValue("X-Trace");
	});
});

describe("the key/value table it borrows", () => {
	/*
	 * The point of #564. These rows were plain `Input` pairs because
	 * `KeyValueRow` called `useRequestBuilderContext()` in its body and that
	 * hook throws with no provider above it - so the app's key/value primitive,
	 * and every fix that lands in it, could not reach this panel. Restore the
	 * hook and this whole file fails to render.
	 */
	it("mounts with no RequestBuilderProvider anywhere above it", () => {
		render(
			<CannedResponseControls
				response={response({ headers: { "X-Trace": "abc" } })}
				pending={false}
				stopped={false}
				onApply={vi.fn()}
			/>
		);
		expect(headerName(0)).toHaveValue("X-Trace");
	});

	it("offers no variable affordances, because a canned reply has no scope", () => {
		// `{{trace}}` is sent verbatim by the engine. A token here would colour
		// it "not defined" and open an editor with nowhere to write.
		const { container } = render(
			<CannedResponseControls
				response={response({ headers: { "X-Trace": "{{trace}}" } })}
				pending={false}
				stopped={false}
				onApply={vi.fn()}
			/>
		);
		expect(headerValue(0)).toHaveValue("{{trace}}");
		expect(container.querySelector("[data-variable-token]")).toBeNull();
		expect(container.querySelector('[aria-label^="Resolved value of"]')).toBeNull();
	});
});

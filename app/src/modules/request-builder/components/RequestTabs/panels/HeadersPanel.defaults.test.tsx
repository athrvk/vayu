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
 * The "Added by Vayu" group (issue #1229).
 *
 * The defect this replaces was three rows the app wrote *into* the request: the
 * user saw them in the table, could not edit them, and the first save stored
 * them. So the two things worth pinning are that the group renders what the
 * engine declares - not a set this panel re-derived - and that untickng a row
 * writes to `disabledDefaultHeaders` and to nothing else. Put a declared header
 * back into `request.headers` and the last case here fails.
 *
 * The tick reaches the wire through `disabledDefaults`, the one helper all four
 * send sites use, so that is what the payload assertion drives.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import type { RequestDefaults } from "@/types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { disabledDefaults } from "../../../utils/execute-mapping";

/** What the engine declares for these tests - one fixed row, one generated. */
const DECLARED: RequestDefaults = {
	headers: [
		{ name: "User-Agent", value: "Vayu/0.1.1", generated: false },
		{
			name: "Accept-Encoding",
			value: "gzip, deflate, br",
			generated: false,
			configKey: "negotiateCompression",
		},
		{ name: "X-Vayu-Request-Id", generated: true, configKey: "correlationIdEnabled" },
	],
};

let declared: RequestDefaults | undefined = DECLARED;
let currentCtx: RequestBuilderContextValue;

vi.mock("@/queries", () => ({
	useRequestDefaultsQuery: () => ({ data: declared }),
}));

// Both paths: the panel takes the hook from the module index, `useVariableSupport`
// from the file behind it, and a mock of one is not a mock of the other.
vi.mock("../../../context", () => ({ useRequestBuilderContext: () => currentCtx }));
vi.mock("../../../context/RequestBuilderContext", () => ({
	useRequestBuilderContext: () => currentCtx,
}));

const { default: HeadersPanel } = await import("./HeadersPanel");

/**
 * A live-enough context: the panel's write has to survive to the next render
 * the way the provider's state does.
 *
 * `updateField` is a spy rather than a writer, because which setter the panel
 * reaches for is itself a rule here: `updateField` marks the tab dirty, and an
 * opt-out that is never saved must not.
 */
function harness(initial: Partial<RequestState> = {}) {
	let request: RequestState = { ...createDefaultRequestState(), id: "req_1", ...initial };
	const updateField = vi.fn();

	const ctx = {
		request,
		updateField,
		setDisabledDefaultHeaders: (names: string[]) => {
			request = { ...request, disabledDefaultHeaders: names };
			ctx.request = request;
		},
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: () => {},
		writableScopes: [],
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;

	return {
		ctx,
		updateField,
		get request() {
			return request;
		},
	};
}

function mount(h: ReturnType<typeof harness>) {
	currentCtx = h.ctx;
	const view = render(<HeadersPanel />);
	return {
		tick: (name: string) => screen.getByRole("checkbox", { name: `Send ${name}` }),
		rerender: () => {
			currentCtx = h.ctx;
			view.rerender(<HeadersPanel />);
		},
	};
}

beforeEach(() => {
	declared = DECLARED;
});

describe("the rows the engine declares", () => {
	it("renders one per declared default, ticked on", () => {
		const ui = mount(harness());

		for (const header of DECLARED.headers) {
			expect(ui.tick(header.name)).toBeChecked();
		}
	});

	it("prints the value it will send, and says so when there is none to print", () => {
		mount(harness());

		expect(screen.getByText("gzip, deflate, br")).toBeInTheDocument();
		// A generated header has no value until the send makes one; an empty
		// cell would read as "sent with no value".
		expect(screen.getByText("generated per request")).toBeInTheDocument();
	});

	it("renders nothing at all when the engine declares nothing", () => {
		declared = { headers: [] };
		mount(harness());

		expect(screen.queryByText(/added by vayu/i)).not.toBeInTheDocument();
	});

	it("survives an engine that has not answered yet", () => {
		declared = undefined;
		mount(harness());

		expect(screen.queryByText(/added by vayu/i)).not.toBeInTheDocument();
	});
});

describe("switching one off", () => {
	it("sends its name and only its name on the wire", () => {
		const h = harness();
		const ui = mount(h);

		fireEvent.click(ui.tick("User-Agent"));

		expect(h.request.disabledDefaultHeaders).toEqual(["User-Agent"]);
		expect(disabledDefaults(h.request)).toEqual({ disabledDefaultHeaders: ["User-Agent"] });
	});

	it("omits the field entirely while every default is on", () => {
		// Not `[]`: a send refusing nothing has to be the payload it was before
		// the field existed.
		const h = harness();
		mount(h);

		expect(disabledDefaults(h.request)).toEqual({});
	});

	it("takes the tick back", () => {
		const h = harness();
		const ui = mount(h);

		fireEvent.click(ui.tick("Accept-Encoding"));
		ui.rerender();
		expect(ui.tick("Accept-Encoding")).not.toBeChecked();

		fireEvent.click(ui.tick("Accept-Encoding"));
		expect(h.request.disabledDefaultHeaders).toEqual([]);
	});

	it("does not mark the request unsaved", () => {
		// The opt-out belongs to this send and is never written to the request,
		// so a tick must not raise an unsaved-changes badge or let autosave PUT
		// a request whose stored fields nobody touched. `updateField` is the
		// setter that would: reaching for it here is the failure.
		const h = harness();
		const ui = mount(h);

		fireEvent.click(ui.tick("User-Agent"));

		expect(h.updateField).not.toHaveBeenCalled();
		expect(h.request.disabledDefaultHeaders).toEqual(["User-Agent"]);
	});

	it("writes nothing into the request's own headers", () => {
		// The whole point of issue #1229: what Vayu adds is displayed, never
		// stored. `handleSave` writes `request.headers` verbatim, so a declared
		// row landing here is a row that would be saved.
		const h = harness();
		const ui = mount(h);

		fireEvent.click(ui.tick("User-Agent"));
		ui.rerender();
		fireEvent.click(ui.tick("X-Vayu-Request-Id"));

		const keys = h.request.headers.map((row) => row.key);
		expect(keys).toEqual([""]);
	});
});

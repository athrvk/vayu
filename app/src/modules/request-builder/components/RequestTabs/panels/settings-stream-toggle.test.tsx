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
 * The Event stream toggle, and the header it arms (issue #574).
 *
 * Rendered rather than scanned, because the thing that can go wrong is the
 * *pairing*: the flag and the `Accept` row are one change, and a panel doing
 * them as two `updateField` calls would compute the header list against the
 * array it had before the first. `switchAutoHeader` has its own unit tests -
 * what these prove is that this panel calls it, with this request's id, and
 * writes both halves at once.
 *
 * A Radix `Switch` is a real button under jsdom, unlike the Select beside it,
 * so this is drivable end to end.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { ACCEPT_HEADER, SSE_ACCEPT } from "@/constants/request";
import type { AutoHeader, RequestState } from "../../../types";
import type { KeyValueItem } from "@/types";

/**
 * A live-enough context: the panel reads `request` and writes through
 * `setRequest` plus the auto-Accept accessors, and the record has to survive
 * between renders the way the provider's ref does.
 */
function harness(initial: Partial<RequestState> = {}) {
	let request: RequestState = { ...createDefaultRequestState(), id: "req_1", ...initial };
	let auto: AutoHeader | null = null;

	const ctx = {
		request,
		setRequest: (updates: Partial<RequestState>) => {
			request = { ...request, ...updates };
			ctx.request = request;
		},
		updateField: vi.fn(),
		getAutoAccept: () => auto,
		setAutoAccept: (next: AutoHeader | null) => {
			auto = next;
		},
	} as unknown as RequestBuilderContextValue;

	return {
		ctx,
		get request() {
			return request;
		},
		get accepts(): KeyValueItem[] {
			return request.headers.filter(
				(h) => h.key.trim().toLowerCase() === ACCEPT_HEADER.toLowerCase()
			);
		},
	};
}

vi.mock("../../../context", () => ({
	useRequestBuilderContext: () => currentCtx,
}));

let currentCtx: RequestBuilderContextValue;

const { default: SettingsPanel } = await import("./SettingsPanel");

function mount(h: ReturnType<typeof harness>) {
	currentCtx = h.ctx;
	const view = render(<SettingsPanel />);
	return {
		toggle: () => screen.getByRole("switch", { name: /event stream/i }),
		rerender: () => {
			currentCtx = h.ctx;
			view.rerender(<SettingsPanel />);
		},
	};
}

describe("the Event stream toggle", () => {
	it("is off by default", () => {
		const ui = mount(harness());
		expect(ui.toggle().getAttribute("aria-checked")).toBe("false");
	});

	it("reads the flag the request was saved with", () => {
		// The hop that fails silently: a stored stream request that loaded with
		// the toggle off would be downgraded by the very next auto-save.
		const ui = mount(harness({ stream: true }));
		expect(ui.toggle().getAttribute("aria-checked")).toBe("true");
	});

	it("sets the flag and arms Accept in one change", () => {
		const h = harness();
		const ui = mount(h);

		fireEvent.click(ui.toggle());

		expect(h.request.stream).toBe(true);
		expect(h.accepts).toHaveLength(1);
		expect(h.accepts[0]).toMatchObject({ value: SSE_ACCEPT, enabled: true });
	});

	it("takes the Accept row back when it is turned off again", () => {
		const h = harness();
		const ui = mount(h);

		fireEvent.click(ui.toggle());
		ui.rerender();
		fireEvent.click(ui.toggle());

		expect(h.request.stream).toBe(false);
		// The bug this rule exists for: nothing removed the header, so one visit
		// left it on the request for good.
		expect(h.accepts).toHaveLength(0);
	});

	it("never overrides an Accept the request already declares", () => {
		const declared: KeyValueItem = {
			id: "mine",
			key: "Accept",
			value: "application/json",
			enabled: true,
		};
		const h = harness({ headers: [declared] });
		const ui = mount(h);

		fireEvent.click(ui.toggle());

		expect(h.request.stream).toBe(true);
		expect(h.accepts).toEqual([declared]);
	});

	it("warns that a streaming send cannot carry scripts, only while it is on", () => {
		// The engine refuses it with a 400, and the scripts a send carries
		// include the collection chain's - which this tab cannot show at all.
		const h = harness();
		const ui = mount(h);
		expect(screen.queryByText(/cannot run on a streaming request/i)).toBeNull();

		fireEvent.click(ui.toggle());
		ui.rerender();

		expect(screen.getByText(/cannot run on a streaming request/i)).toBeTruthy();
	});
});

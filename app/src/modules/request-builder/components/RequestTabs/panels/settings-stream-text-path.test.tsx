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
 * The stream text path field under Event stream (issue #3773).
 *
 * The field belongs to a stream: shown only while Event stream is on, and
 * emptied by the toggle going off, since the engine refuses a path stored
 * beside a buffered request. The presets are shortcuts for the two declared
 * shapes - they write the field, and the field is the only source of truth.
 *
 * The first content marker (issue #3774) sits beside it under the same rules,
 * and is kept verbatim: it is matched byte for byte, so nothing is trimmed.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { STREAM_FIRST_CONTENT_MARKER_PRESETS, STREAM_TEXT_PATH_PRESETS } from "@/constants/request";

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useRequestDefaultsQuery: () => ({ data: undefined }),
	useConfigQuery: () => ({ data: undefined }),
}));

const OPENAI = "$.choices[0].delta.content";
const ANTHROPIC = "$.delta.text";

/** The panel reads `request` and writes through `setRequest` / `updateField`. */
function harness(initial: Partial<RequestState> = {}) {
	let request: RequestState = { ...createDefaultRequestState(), id: "req_1", ...initial };
	const ctx = {
		request,
		setRequest: (updates: Partial<RequestState>) => {
			request = { ...request, ...updates };
			ctx.request = request;
		},
		updateField: (field: keyof RequestState, value: unknown) => {
			request = { ...request, [field]: value };
			ctx.request = request;
		},
	} as unknown as RequestBuilderContextValue;
	return {
		ctx,
		get request() {
			return request;
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
		rerender: () => {
			currentCtx = h.ctx;
			view.rerender(<SettingsPanel />);
		},
	};
}

const field = () => screen.queryByRole("textbox", { name: /stream text path/i });

describe("the stream text path field", () => {
	it("is absent while Event stream is off, and present once it is on", () => {
		const ui = mount(harness());
		expect(field()).toBeNull();
		expect(screen.queryByRole("radio", { name: /openai/i })).toBeNull();

		fireEvent.click(screen.getByRole("switch", { name: /event stream/i }));
		ui.rerender();

		expect(field()).not.toBeNull();
		expect(screen.getByRole("radio", { name: /openai/i })).toBeTruthy();
	});

	it("shows the stored path and names the shape it reads", () => {
		mount(harness({ stream: true, streamTextPath: ANTHROPIC }));
		expect((field() as HTMLInputElement).value).toBe(ANTHROPIC);
		expect(screen.getByText(/JSONPath read on each event/i)).toBeTruthy();
	});

	it("writes what is typed into the request", () => {
		const h = harness({ stream: true });
		mount(h);

		fireEvent.change(field() as HTMLInputElement, { target: { value: "$.text" } });

		expect(h.request.streamTextPath).toBe("$.text");
	});

	it("offers the OpenAI-compatible and Anthropic presets, each writing its path", () => {
		expect(STREAM_TEXT_PATH_PRESETS.map((p) => p.path)).toEqual([OPENAI, ANTHROPIC]);
		const h = harness({ stream: true });
		const ui = mount(h);

		fireEvent.click(screen.getByRole("radio", { name: /openai-compatible/i }));
		expect(h.request.streamTextPath).toBe(OPENAI);

		ui.rerender();
		fireEvent.click(screen.getByRole("radio", { name: /anthropic/i }));
		expect(h.request.streamTextPath).toBe(ANTHROPIC);
	});

	it("marks the preset the field holds, and none once the path is hand-written", () => {
		const h = harness({ stream: true, streamTextPath: OPENAI });
		const ui = mount(h);
		expect(
			screen.getByRole("radio", { name: /openai-compatible/i }).getAttribute("aria-checked")
		).toBe("true");

		h.ctx.updateField("streamTextPath", "$.custom");
		ui.rerender();
		expect(
			screen.getByRole("radio", { name: /openai-compatible/i }).getAttribute("aria-checked")
		).toBe("false");
	});

	it("keeps the path when the active preset is pressed again", () => {
		const h = harness({ stream: true, streamTextPath: OPENAI });
		mount(h);

		fireEvent.click(screen.getByRole("radio", { name: /openai-compatible/i }));

		expect(h.request.streamTextPath).toBe(OPENAI);
	});

	it("empties with the toggle, so no path is saved beside a buffered request", () => {
		const h = harness({ stream: true, streamTextPath: OPENAI });
		mount(h);

		fireEvent.click(screen.getByRole("switch", { name: /event stream/i }));

		expect(h.request.stream).toBe(false);
		expect(h.request.streamTextPath).toBe("");
	});
});

const markerField = () => screen.queryByRole("textbox", { name: /first content marker/i });
const CONTENT_BLOCK_DELTA = "content_block_delta";
const OPENAI_CONTENT = '"delta":{"content":"';

describe("the first content marker field", () => {
	it("is absent while Event stream is off, and present once it is on", () => {
		const ui = mount(harness());
		expect(markerField()).toBeNull();
		expect(screen.queryByRole("radio", { name: CONTENT_BLOCK_DELTA })).toBeNull();

		fireEvent.click(screen.getByRole("switch", { name: /event stream/i }));
		ui.rerender();

		expect(markerField()).not.toBeNull();
		expect(screen.getByRole("radio", { name: CONTENT_BLOCK_DELTA })).toBeTruthy();
	});

	it("shows the stored marker and says it is matched against the raw stream", () => {
		mount(harness({ stream: true, streamFirstContentMarker: CONTENT_BLOCK_DELTA }));
		expect((markerField() as HTMLInputElement).value).toBe(CONTENT_BLOCK_DELTA);
		expect(screen.getByText(/matched against the raw stream/i)).toBeTruthy();
	});

	it("writes what is typed into the request, spaces and all", () => {
		const h = harness({ stream: true });
		mount(h);

		fireEvent.change(markerField() as HTMLInputElement, { target: { value: ' "text": "' } });

		expect(h.request.streamFirstContentMarker).toBe(' "text": "');
	});

	it("offers the two literals as presets, each writing its marker", () => {
		expect([...STREAM_FIRST_CONTENT_MARKER_PRESETS]).toEqual([
			CONTENT_BLOCK_DELTA,
			OPENAI_CONTENT,
		]);
		const h = harness({ stream: true });
		const ui = mount(h);

		fireEvent.click(screen.getByRole("radio", { name: CONTENT_BLOCK_DELTA }));
		expect(h.request.streamFirstContentMarker).toBe(CONTENT_BLOCK_DELTA);

		ui.rerender();
		fireEvent.click(screen.getByRole("radio", { name: OPENAI_CONTENT }));
		expect(h.request.streamFirstContentMarker).toBe(OPENAI_CONTENT);
	});

	it("marks the preset the field holds, and none once the marker is hand-written", () => {
		const h = harness({ stream: true, streamFirstContentMarker: CONTENT_BLOCK_DELTA });
		const ui = mount(h);
		const preset = () => screen.getByRole("radio", { name: CONTENT_BLOCK_DELTA });
		expect(preset().getAttribute("aria-checked")).toBe("true");

		h.ctx.updateField("streamFirstContentMarker", "custom");
		ui.rerender();
		expect(preset().getAttribute("aria-checked")).toBe("false");
	});

	it("keeps the marker when the active preset is pressed again", () => {
		const h = harness({ stream: true, streamFirstContentMarker: CONTENT_BLOCK_DELTA });
		mount(h);

		fireEvent.click(screen.getByRole("radio", { name: CONTENT_BLOCK_DELTA }));

		expect(h.request.streamFirstContentMarker).toBe(CONTENT_BLOCK_DELTA);
	});

	it("empties with the toggle, so no marker is saved beside a buffered request", () => {
		const h = harness({ stream: true, streamFirstContentMarker: CONTENT_BLOCK_DELTA });
		mount(h);

		fireEvent.click(screen.getByRole("switch", { name: /event stream/i }));

		expect(h.request.stream).toBe(false);
		expect(h.request.streamFirstContentMarker).toBe("");
	});
});

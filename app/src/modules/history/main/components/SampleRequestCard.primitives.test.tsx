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
 * Issue #60 guard: the load-test sample paths must *consume* the shared
 * response-viewer primitives, not hand-roll them - a hand-rolled copy does not
 * receive the primitive's fixes.
 *
 * These are mutation-check tests. Revert the status chip to the local `? "ERR"`
 * Badge and the class assertion fails; render the captured response with a
 * hand-rolled header list instead of `UnifiedResponseViewer` and the
 * `surface-sunken` assertion fails.
 *
 * The headers assertion used to be fed `trace.request.headers` - the
 * design-mode nesting, on a load-run-only surface, which no writer produces.
 * It exercised a dead branch. Since issue #174 the exchange arrives from
 * `GET /runs/:id/samples` as the `captured` prop, so the same guard now runs
 * over data a real run actually stores.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SampleRequestCard from "./SampleRequestCard";
import type { SampleResult } from "../../types";
import type { RunSample } from "@/types/domain";

// The response body path mounts Monaco via CodeEditor; stub it so these tests
// stay in jsdom. None of the samples below carry a response, so it never
// actually renders - the mock is belt-and-braces.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

function makeSample(overrides: Partial<SampleResult> = {}): SampleResult {
	return {
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		latencyMs: 5,
		...overrides,
	};
}

function makeCaptured(response: Partial<RunSample["response"]> = {}): RunSample {
	return {
		resultId: 1,
		response: { headers: {}, bodyBytes: 0, ...response },
	};
}

describe("SampleRequestCard shared-primitive adoption (#60)", () => {
	it("renders the status through StatusCodeBadge (ERR chip on a connection failure)", () => {
		render(
			<SampleRequestCard
				sample={makeSample({ statusCode: 0 })}
				index={0}
				isExpanded={false}
				onToggle={() => {}}
			/>
		);
		const chip = screen.getByText("ERR");
		// StatusCodeBadge is variant="chip": a white label on a solid semantic
		// fill. The old hand-rolled Badge used destructive/default variants and
		// carried neither of these classes.
		expect(chip.className).toContain("text-primary-foreground");
		expect(chip.className).toContain("bg-status-no-response-fill");
	});

	it("renders captured response headers through the shared viewer, not a hand-rolled list", () => {
		const { container } = render(
			<SampleRequestCard
				sample={makeSample()}
				index={0}
				isExpanded
				onToggle={() => {}}
				captured={makeCaptured({
					headers: { "x-trace-id": "abc123" },
					body: "",
					bodyBytes: 0,
				})}
			/>
		);
		// Headers live behind UnifiedResponseViewer's Headers tab - which is the
		// point of routing them through the shared viewer rather than printing
		// a second, differently-styled table beside it.
		// Radix Tabs activate on pointer-down, not click.
		fireEvent.mouseDown(screen.getByRole("tab", { name: /Headers/ }));
		// CompactHeadersViewer renders each name as `key:` on a sunken slab;
		// pin that surface, since a hand-rolled div map would render the same
		// text without it.
		const name = screen.getByText("x-trace-id:");
		expect(name.closest(".surface-sunken")).not.toBeNull();
		expect(screen.getByText("abc123")).toBeTruthy();
		// The reverted implementation dumped the headers as pretty-printed JSON in
		// a <pre>. There is none now.
		expect(container.querySelector("pre")).toBeNull();
	});
});

describe("SampleRequestCard captured exchange (#174)", () => {
	it("renders nothing about the response when the run captured none", () => {
		const { container } = render(
			<SampleRequestCard sample={makeSample()} index={0} isExpanded onToggle={() => {}} />
		);
		// No empty "Response" heading, no headers table: most samples in a
		// healthy run carry no body, and a heading over nothing reads as a bug
		// in the engine rather than as "this sample has none".
		expect(container.querySelector("table")).toBeNull();
	});

	it("says a body was truncated rather than showing a slice as the whole response", () => {
		render(
			<SampleRequestCard
				sample={makeSample()}
				index={0}
				isExpanded
				onToggle={() => {}}
				captured={makeCaptured({
					headers: {},
					body: "{".repeat(8),
					bodyBytes: 500_000,
					bodyTruncated: true,
				})}
			/>
		);
		expect(screen.getByText("Body truncated")).toBeTruthy();
	});

	it("reports a binary body by size and type instead of rendering its bytes", () => {
		render(
			<SampleRequestCard
				sample={makeSample()}
				index={0}
				isExpanded
				onToggle={() => {}}
				captured={makeCaptured({
					headers: {},
					bodyBytes: 2048,
					binary: true,
					contentType: "image/png",
				})}
			/>
		);
		expect(screen.getByText("Binary response")).toBeTruthy();
		expect(screen.getByText(/image\/png/)).toBeTruthy();
	});

	it("distinguishes a body dropped for budget from an empty response", () => {
		render(
			<SampleRequestCard
				sample={makeSample()}
				index={0}
				isExpanded
				onToggle={() => {}}
				captured={makeCaptured({
					headers: { "content-type": "application/json" },
					bodyBytes: 4096,
					bodyDropped: true,
				})}
			/>
		);
		expect(screen.getByText("Body not captured")).toBeTruthy();
	});
});

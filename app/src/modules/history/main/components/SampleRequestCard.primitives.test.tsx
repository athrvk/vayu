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
 * Badge and the class assertion fails; revert the request headers to the
 * `<pre>{JSON.stringify(...)}</pre>` dump and the "renders a <table>, not a
 * <pre>" assertion fails.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SampleRequestCard from "./SampleRequestCard";
import type { SampleResult } from "../../types";

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

	it("renders request headers through HeadersViewer (a table), not a raw JSON <pre>", () => {
		const { container } = render(
			<SampleRequestCard
				sample={makeSample({
					trace: { request: { headers: { "x-trace-id": "abc123" } } },
				})}
				index={0}
				isExpanded
				onToggle={() => {}}
			/>
		);
		const table = container.querySelector("table");
		expect(table).not.toBeNull();
		expect(table?.textContent).toContain("x-trace-id");
		expect(table?.textContent).toContain("abc123");
		// The reverted implementation dumped the headers as pretty-printed JSON in
		// a <pre>. There is none now.
		expect(container.querySelector("pre")).toBeNull();
	});
});

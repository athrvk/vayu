/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * The History row's warning glyph (issue #1527).
 *
 * `RunSummary.hasWarnings` is the only signal the row has for issue #1503's
 * `warnings` array - the row never sees the array itself, only this boolean -
 * so the glyph's presence is a straight read of that one field. No adjacent
 * text says "this run has warnings" the way the status text explains the
 * status dot, so the icon has to carry its own accessible name.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RunItem from "./RunItem";
import type { Run } from "@/types";

function loadRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.example.test/checkout", method: "POST" },
		...overrides,
	} as Run;
}

const noop = () => {};

describe("RunItem warning glyph", () => {
	it("shows the glyph when the row's summary carries hasWarnings", () => {
		render(
			<RunItem
				run={loadRun({ summary: { hasWarnings: true } })}
				onSelect={noop}
				onDelete={noop}
				isDeleting={false}
			/>
		);
		expect(
			screen.getByRole("img", { name: "This run has warnings - see its report" })
		).toBeInTheDocument();
	});

	it("shows no glyph when hasWarnings is absent", () => {
		render(
			<RunItem
				run={loadRun({ summary: { url: "https://api.example.test/checkout" } })}
				onSelect={noop}
				onDelete={noop}
				isDeleting={false}
			/>
		);
		expect(
			screen.queryByRole("img", { name: "This run has warnings - see its report" })
		).not.toBeInTheDocument();
	});

	// The false half, not only the absent one: a stale row from before this
	// field existed and a row explicitly cleared both read the same way.
	it("shows no glyph when hasWarnings is explicitly false", () => {
		render(
			<RunItem
				run={loadRun({ summary: { hasWarnings: false } })}
				onSelect={noop}
				onDelete={noop}
				isDeleting={false}
			/>
		);
		expect(
			screen.queryByRole("img", { name: "This run has warnings - see its report" })
		).not.toBeInTheDocument();
	});

	it("shows no glyph on a run with no summary at all", () => {
		render(
			<RunItem
				run={loadRun({ summary: undefined })}
				onSelect={noop}
				onDelete={noop}
				isDeleting={false}
			/>
		);
		expect(
			screen.queryByRole("img", { name: "This run has warnings - see its report" })
		).not.toBeInTheDocument();
	});
});

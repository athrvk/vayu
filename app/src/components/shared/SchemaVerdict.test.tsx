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
 * The run-level schema block (issue #681).
 *
 * Every case here is a way the block could mislead rather than a way it could
 * look wrong: rendering anything at all for a run nothing judged, reading a
 * sampled tally as if it covered every response, folding unchecked responses
 * into the passes, or showing a clean count beside a schema that was only half
 * evaluated.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SchemaVerdict } from "./SchemaVerdict";
import type { RunSchemaValidation } from "@/types/domain";

afterEach(cleanup);

const validation = (over: Partial<RunSchemaValidation> = {}): RunSchemaValidation => ({
	responses: 10,
	checked: 8,
	valid: 8,
	failed: 0,
	partlyChecked: 0,
	sampled: false,
	...over,
});

describe("SchemaVerdict", () => {
	it("renders nothing for a run that was not measured against a contract", () => {
		const { container } = render(<SchemaVerdict validation={undefined} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing for a block that judged no response", () => {
		// The engine writes no such block, but a report from an older engine (or
		// a hand-edited summary) must not become "0 / 0 matched" - "not judged"
		// and "judged nothing" are the distinction the whole feature turns on.
		const { container } = render(
			<SchemaVerdict validation={validation({ responses: 0, checked: 0, valid: 0 })} />
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("leads with the failure count when something failed", () => {
		render(<SchemaVerdict validation={validation({ checked: 8, valid: 5, failed: 3 })} />);
		expect(screen.getByText("3 failed")).toBeTruthy();
	});

	it("states the three numbers without implying they partition", () => {
		render(<SchemaVerdict validation={validation({ checked: 8, valid: 5, failed: 3 })} />);
		expect(screen.getByText(/8 of 10 responses checked/)).toBeTruthy();
		expect(screen.getByText(/5 matched the declared schema, 3 did not/)).toBeTruthy();
	});

	it("says which responses the counts describe", () => {
		const { unmount } = render(<SchemaVerdict validation={validation()} />);
		expect(screen.getByText(/every step this run executed/i)).toBeTruthy();
		unmount();

		// A load run validates the reservoir it kept, so "0 failed" there is a
		// narrower claim and the block has to say so.
		render(<SchemaVerdict validation={validation({ sampled: true })} />);
		expect(screen.getByText(/responses this run kept/i)).toBeTruthy();
	});

	it("discloses the responses it could not check rather than hiding them in the total", () => {
		render(<SchemaVerdict validation={validation({ responses: 10, checked: 8 })} />);
		// 10 - 8, said out loud: without it, "8 matched" beside "10 responses"
		// reads as two that failed.
		expect(screen.getByText(/2 could not be checked/i)).toBeTruthy();
	});

	it("says nothing about unchecked responses when every one was checked", () => {
		render(<SchemaVerdict validation={validation({ responses: 8, checked: 8 })} />);
		expect(screen.queryByText(/could not be checked/i)).toBeNull();
	});

	it("discloses a partly evaluated schema beside a clean count", () => {
		render(<SchemaVerdict validation={validation({ partlyChecked: 3 })} />);
		expect(screen.getByText(/only partly evaluate/i)).toBeTruthy();
	});

	it("mentions the gate only when the run used it", () => {
		const { unmount } = render(<SchemaVerdict validation={validation()} />);
		expect(screen.queryByText(/failed any step/i)).toBeNull();
		unmount();

		render(<SchemaVerdict validation={validation({ failOnSchemaError: true })} />);
		expect(screen.getByText(/failed any step/i)).toBeTruthy();
	});
});

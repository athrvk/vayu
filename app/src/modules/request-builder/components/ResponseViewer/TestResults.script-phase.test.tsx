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
 * Which script made an assertion (issue #810).
 *
 * `pm.test` is bound in both script phases, and a pre-request assertion -
 * typically about a `pm.sendRequest` the script made - already failed its
 * collection-run step while appearing in no list at all. The engine lists both
 * phases now, so this pane has to say which is which: an assertion made before
 * the request went out is a different claim from one about the response, and a
 * list that ran them together would report the first as the second.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import TestResults from "./TestResults";
import type { TestResult } from "@/types";

afterEach(cleanup);

const PRE_REQUEST: TestResult = { name: "token was issued", passed: true, source: "pre" };
const POST_REQUEST: TestResult = { name: "status is 200", passed: true, source: "test" };

/** The section a heading owns, so a row is read where it actually renders. */
function sectionFor(label: string): HTMLElement {
	const heading = screen.getByText(label);
	const section = heading.closest("section");
	expect(section).not.toBeNull();
	return section as HTMLElement;
}

describe("TestResults grouped by script", () => {
	it("puts each assertion under the script that made it", () => {
		render(<TestResults results={[PRE_REQUEST, POST_REQUEST]} />);

		expect(within(sectionFor("Pre-request script")).getByText("token was issued")).toBeTruthy();
		expect(within(sectionFor("Post-request script")).getByText("status is 200")).toBeTruthy();
	});

	it("names the script even when only one of them asserted", () => {
		// The case the grouping exists for: a list of pre-request assertions
		// alone, which without a heading reads as assertions about a response
		// that had not arrived yet.
		render(<TestResults results={[PRE_REQUEST]} />);

		expect(sectionFor("Pre-request script")).toBeTruthy();
		expect(screen.queryByText("Post-request script")).toBeNull();
	});

	it("reads an assertion with no source as the test script's", () => {
		// What a trace stored - or an engine sidecar answering - before #810
		// carries: the post-request script's assertions and no phase on them.
		// That list meant "test script", so it keeps meaning it.
		render(<TestResults results={[{ name: "status is 200", passed: true }]} />);

		expect(within(sectionFor("Post-request script")).getByText("status is 200")).toBeTruthy();
		expect(screen.queryByText("Pre-request script")).toBeNull();
	});

	it("counts both scripts in the summary", () => {
		render(
			<TestResults
				results={[
					PRE_REQUEST,
					{ name: "fixture is present", passed: false, source: "pre" },
					POST_REQUEST,
				]}
			/>
		);

		// 2 passed, 1 failed - the tally the engine's step frame publishes for
		// the same three assertions, so the pane and the live chip agree.
		expect(screen.getByText("2")).toBeTruthy();
		expect(screen.getByText("1")).toBeTruthy();
		expect(screen.getByText(/failed/)).toBeTruthy();
	});
});

/**
 * Which level an assertion came from (issue #2522). A request runs the
 * assertions of every collection and folder it inherits, and without a label
 * the list reads as though the request's own script wrote all of them.
 */
describe("TestResults level labels", () => {
	it("labels a collection's and a folder's assertion, and leaves the rest bare", () => {
		render(
			<TestResults
				results={[
					{ name: "from the root", passed: true, source: "test", scope: "collection" },
					{ name: "from a folder", passed: true, source: "test", scope: "folder" },
					{ name: "from the request", passed: true, source: "test", scope: "request" },
					{ name: "stored before the field", passed: true, source: "test" },
				]}
			/>
		);

		const card = (name: string) => screen.getByText(name).parentElement as HTMLElement;
		expect(within(card("from the root")).getByText("Collection")).toBeTruthy();
		expect(within(card("from a folder")).getByText("Folder")).toBeTruthy();
		expect(
			within(card("from the request")).queryByText(/^(Collection|Folder|Request)$/)
		).toBeNull();
		expect(
			within(card("stored before the field")).queryByText(/^(Collection|Folder|Request)$/)
		).toBeNull();
	});

	it("draws the label as neutral text, never a status tint", () => {
		render(
			<TestResults
				results={[
					{ name: "from the root", passed: false, source: "test", scope: "collection" },
				]}
			/>
		);

		const label = screen.getByText("Collection");
		expect(label).toHaveClass("text-muted-foreground");
		expect(label.className).not.toContain("status-");
	});
});

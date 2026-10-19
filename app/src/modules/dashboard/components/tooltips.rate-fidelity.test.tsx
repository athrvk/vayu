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
 * Which window each rate tooltip speaks about (#2392). Rate fidelity is about
 * what was sent over the sending window, and the end-of-run wait is outside it;
 * throughput is about completions, and includes that wait once the run is over.
 * The tooltip is the only place a reader is told, so the claim is held here -
 * as the two windows, not as the sentence.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TOOLTIPS } from "./tooltips";

const textOf = (tip: React.ReactNode) =>
	render(<div>{tip}</div>).container.textContent?.replace(/\s+/g, " ") ?? "";

describe("rate tooltips", () => {
	it("names the sending window and leaves the drain out of Rate fidelity", () => {
		const text = textOf(TOOLTIPS.rateFidelity);

		expect(text).toContain("sending window");
		expect(text).toMatch(/requests sent/i);
		expect(text).toMatch(/not counted/i);
	});

	it("labels the window Throughput is measured over", () => {
		const text = textOf(TOOLTIPS.throughput);

		expect(text).toMatch(/so far/);
		expect(text).toMatch(/whole run/);
		expect(text).toMatch(/last responses/);
	});
});

/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LatencyStat } from "./LatencyStat";

const read = (v: number | undefined) => render(<LatencyStat k="p99" v={v} />).container.textContent;

describe("LatencyStat", () => {
	it("keeps a sub-second figure in milliseconds", () => {
		expect(read(42.5)).toBe("p99 43ms");
	});

	it("moves a figure past a second into seconds, as the chart tooltips do", () => {
		expect(read(1234)).toBe("p99 1.23s");
	});

	it("draws a dash and no unit when the report lacks the figure", () => {
		expect(read(undefined)).toBe("p99 -");
	});
});

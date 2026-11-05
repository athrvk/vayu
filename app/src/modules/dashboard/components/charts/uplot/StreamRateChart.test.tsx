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
import { tick } from "../../../utils/liveDistributions.testkit";
import { StreamRateChart } from "./index";

describe("StreamRateChart", () => {
	it("renders nothing below two buckets, the guard every time-series chart uses", () => {
		const { container } = render(
			<StreamRateChart history={[tick(0, { events_per_second: 0 })]} />
		);
		expect(container.innerHTML).toBe("");
	});

	it("mounts a plot for a streaming run's frames, a leading measured 0 included", () => {
		const history = [0, 1, 2, 3].map((i) => tick(i, { events_per_second: i * 50 }));
		const { container } = render(<StreamRateChart history={history} />);
		expect(container.innerHTML).not.toBe("");
	});
});

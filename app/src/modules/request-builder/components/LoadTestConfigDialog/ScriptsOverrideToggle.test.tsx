/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ScriptsOverrideToggle } from "./ScriptsOverrideToggle";

afterEach(cleanup);

describe("ScriptsOverrideToggle", () => {
	it("reports the segment that was picked", () => {
		const onChange = vi.fn();
		render(<ScriptsOverrideToggle value="asMarked" onChange={onChange} />);
		fireEvent.click(screen.getByRole("radio", { name: "All inline" }));
		expect(onChange).toHaveBeenCalledWith("allInline");
	});

	it("ignores a click on the active segment, which Radix reports as empty", () => {
		const onChange = vi.fn();
		render(<ScriptsOverrideToggle value="allDeferred" onChange={onChange} />);
		fireEvent.click(screen.getByRole("radio", { name: "All deferred" }));
		expect(onChange).not.toHaveBeenCalled();
	});
});

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
 * A filter that matches nothing offers the way back (issue #1693).
 *
 * This is the one empty state in the console tab the user caused, so it is
 * the one that can say what to do about it: the filter field is still on
 * screen but reads as part of the chrome, and "No log matches that filter"
 * without an undo leaves the user to work out that the field above is why.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConsoleOutput from "./ConsoleOutput";

describe("the console tab's no-match state", () => {
	it("clears the filter and brings the logs back", () => {
		render(<ConsoleOutput logs={["[pre] hello world"]} errors={{}} />);
		const field = screen.getByLabelText("Filter console output");

		fireEvent.change(field, { target: { value: "zzz" } });
		expect(screen.getByText("No log matches that filter")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Clear the filter" }));
		expect(screen.queryByText("No log matches that filter")).toBeNull();
		expect(field).toHaveValue("");
	});
});

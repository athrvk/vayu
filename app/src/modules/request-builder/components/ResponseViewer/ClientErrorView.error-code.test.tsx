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
 * The "Error code: ..." line is the string a reader copies into a search or a
 * bug report, so it is held at the canvas-tuned `--muted-foreground`, not at a
 * 70% tint of it, which measured 2.85 to 3.00 in light (#3499).
 *
 * Mutation check: put `/70` back on the class and this fails.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ClientErrorView from "./ClientErrorView";

afterEach(cleanup);

describe("ClientErrorView error code line", () => {
	it("is the muted foreground at full strength", () => {
		render(<ClientErrorView errorCode="CONNECTION_FAILED" errorMessage="detail" />);

		const line = screen.getByText(/Error code: CONNECTION_FAILED/);
		const classes = line.className.split(/\s+/);
		expect(classes).toContain("text-muted-foreground");
		expect(classes.filter((c) => /^text-muted-foreground\//.test(c))).toEqual([]);
	});
});

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
 * The "Error code:" line is the one string a reader copies into a bug report,
 * so it is painted in `--muted-foreground` at full strength. `--muted-foreground`
 * is solved to clear 4.5:1 on its surfaces; at `/70` it composites below that
 * (#3499), and no source scan sees an alpha written into a class string.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ClientErrorView from "./ClientErrorView";

afterEach(cleanup);

describe("ClientErrorView error code line", () => {
	it("is muted-foreground with no alpha", () => {
		render(<ClientErrorView errorCode="CONNECTION_FAILED" errorMessage="detail" />);

		const classes = screen.getByText(/Error code: CONNECTION_FAILED/).className.split(/\s+/);
		expect(classes).toContain("text-muted-foreground");
		expect(classes.filter((c) => c.startsWith("text-muted-foreground/"))).toEqual([]);
	});
});

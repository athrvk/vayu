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
 * The welcome footer reads documentation first and Settings last: the links
 * that explain the product come before the one that configures it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { FooterLinks } from "./FooterLinks";

afterEach(cleanup);

describe("FooterLinks", () => {
	it("lists Documentation, the MCP page, Scripting docs, then Settings", () => {
		render(<FooterLinks />);
		const labels = screen.getAllByRole("button").map((b) => b.textContent);
		expect(labels).toEqual([
			"Documentation",
			"Connect an agent (MCP)",
			"Scripting docs",
			"Settings",
		]);
	});
});

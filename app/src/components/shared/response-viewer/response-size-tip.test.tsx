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
 * The status bar's size says what it counts (#2787): the decoded body, not the
 * wire. Someone comparing it with DevTools or curl on a gzipped reply sees a
 * larger number here and has no way to tell why, so the hover names the scope
 * and, when the headers show the body was encoded, the compressed length too.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResponseStatusBar } from "./ResponseStatusBar";
import { RESPONSE_SIZE_TIP, responseSizeTip } from "./utils";

const sizeElement = (headers?: Record<string, string>) => {
	render(
		<ResponseStatusBar status={200} statusText="OK" time={120} size={81920} headers={headers} />
	);
	const element = screen.getByText("80.0 KB").closest("[title]");
	if (!element) throw new Error("the size element has no title");
	return element;
};

describe("the status bar's size hover", () => {
	it("says the figure is the decoded body", () => {
		const element = sizeElement();
		expect(element).toHaveAttribute("title", RESPONSE_SIZE_TIP);
		expect(element).toHaveAccessibleDescription(/decoded/i);
	});

	it("adds the compressed length when the body was encoded", () => {
		const element = sizeElement({ "content-length": "12595", "content-encoding": "gzip" });
		expect(element.getAttribute("title")).toBe(`${RESPONSE_SIZE_TIP} 12.3 KB on the wire.`);
	});

	it("reads both headers whatever case their names arrived in", () => {
		const element = sizeElement({ "Content-Length": "12595", "Content-Encoding": "br" });
		expect(element.getAttribute("title")).toContain("12.3 KB on the wire");
	});

	it.each([
		["no headers", undefined],
		["a Content-Length alone", { "content-length": "12595" }],
		["a Content-Encoding alone", { "content-encoding": "gzip" }],
		["an identity encoding", { "content-length": "81920", "content-encoding": "identity" }],
		[
			"a Content-Length that is not a number",
			{ "content-length": "12k", "content-encoding": "gzip" },
		],
	])("shows no wire figure for %s", (_name, headers) => {
		const element = sizeElement(headers);
		expect(element.getAttribute("title")).toBe(RESPONSE_SIZE_TIP);
	});
});

describe("the size sentence", () => {
	it("is a scope statement with no em-dash", () => {
		expect(RESPONSE_SIZE_TIP).toMatch(/^Decoded body size\./);
		expect(RESPONSE_SIZE_TIP).not.toMatch(/—/);
		expect(responseSizeTip({ "content-length": "1", "content-encoding": "gzip" })).not.toMatch(
			/—/
		);
	});
});

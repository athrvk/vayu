/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { pathLabel } from "./path-label";

describe("pathLabel", () => {
	it("returns the pathname of a URL that parses", () => {
		expect(pathLabel("https://api.test/v1/x?key=s3cr3t")).toBe("/v1/x");
	});

	it("cuts the query from a URL whose host is an unresolved token", () => {
		expect(pathLabel("{{baseUrl}}/v1/x?key=s3cr3t")).toBe("{{baseUrl}}/v1/x");
	});

	it("cuts the fragment, with or without a query", () => {
		expect(pathLabel("{{baseUrl}}/v1/x#frag")).toBe("{{baseUrl}}/v1/x");
		expect(pathLabel("{{baseUrl}}/v1/x?key=s3cr3t#frag")).toBe("{{baseUrl}}/v1/x");
	});

	it("cuts the query from a templated authority", () => {
		expect(pathLabel("https://{{host}}/x?k=v")).toBe("/x");
	});
});

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The templated snippet is the stored request mapped by hand, so a field it
 * forgets is one the snippet silently lacks (#1445 was `followRedirects`).
 * Path rows (#1764) are the newest such field: without them a `:id` URL
 * copies out literally while Vayu sends the value.
 */

import { describe, it, expect } from "vitest";
import { generateCurl } from "@/services/codegen";
import type { Request } from "@/types";
import { templatedRequest } from "./templated-request";

describe("templatedRequest", () => {
	it("carries the path rows, so the snippet fills `:name` segments", () => {
		const request = {
			method: "GET",
			url: "{{host}}/users/:id",
			params: [{ key: "id", value: "42", enabled: true, in: "path" }],
			headers: [],
			body: { mode: "none" },
			auth: { mode: "none" },
		} as unknown as Request;
		const snippet = templatedRequest(request, []);
		expect(snippet.params).toBe(request.params);
		expect(generateCurl(snippet).code).toContain("'{{host}}/users/42'");
	});
});

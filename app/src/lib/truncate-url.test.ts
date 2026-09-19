/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The half of a URL worth keeping is the end of it (#1691).
 *
 * `truncate` in CSS keeps the head, and for a local run that is the part every
 * row shares: five rows reading `http://127.0.0.1:9...` for five different
 * requests is the bug this exists to fix.
 */

import { describe, it, expect } from "vitest";
import { truncateUrl } from "./truncate-url";

describe("truncateUrl", () => {
	it("leaves a URL that fits alone", () => {
		expect(truncateUrl("http://127.0.0.1:9876/orders", 48)).toBe(
			"http://127.0.0.1:9876/orders"
		);
	});

	it("gives way at the head and keeps the whole path", () => {
		const long = "http://127.0.0.1:9876/api/v3/customers/42/orders";
		const short = truncateUrl(long, 40);

		expect(short).toHaveLength(40);
		expect(short).toContain("/api/v3/customers/42/orders");
		// What is left of the head is its start, so the scheme and as much host as
		// fits stay readable.
		expect(short.startsWith("http://127")).toBe(true);
	});

	it("keeps the path's own tail when even the path does not fit", () => {
		const long = "https://api.example.test/v3/customers/42/orders/7/refunds";
		const short = truncateUrl(long, 20);

		expect(short).toHaveLength(20);
		expect(short.endsWith("/refunds")).toBe(true);
		// The shared prefix is what went, not the identifying end.
		expect(short).not.toContain("api.example.test");
	});

	it("tells two runs on one host apart, which the CSS treatment cannot", () => {
		const a = truncateUrl("http://127.0.0.1:9876/api/v3/customers/42", 28);
		const b = truncateUrl("http://127.0.0.1:9876/api/v3/invoices/42", 28);

		expect(a).not.toBe(b);
	});

	it("truncates the ordinary way when there is no path to keep", () => {
		// A bare host, or a value still being typed. The head *is* the identity
		// here, so there is nothing to preserve at the end.
		expect(truncateUrl("https://very-long-subdomain.example.test", 20)).toBe(
			"https://very-long-s…"
		);
	});

	it("does not parse its input", () => {
		// A row can hold a variable in the authority, or a relative path. `new
		// URL()` throws on both; a display helper must not.
		expect(truncateUrl("{{base_url}}/api/v3/customers/42/orders/7", 24)).toContain(
			"/customers/42/orders/7"
		);
		expect(truncateUrl("/api/v3/customers/42/orders/7/refunds", 18)).toBe("…/orders/7/refunds");
	});
});

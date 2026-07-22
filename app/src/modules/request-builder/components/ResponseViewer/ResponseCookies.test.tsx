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
 * The cookie tab was displaying wrong data, not merely incomplete data.
 *
 * Its parser carried a "simplified" comment and three defects, each of which
 * silently changes what the user reads off the screen. The first two are the
 * ones that matter: a developer who compares this table against what the server
 * actually set would find a cookie that is not there and a value that does not
 * match.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import ResponseCookies from "./ResponseCookies";
import { parseSetCookie } from "./parse-set-cookie";

describe("splitting one header into cookies", () => {
	it("does not break an Expires date at its comma", () => {
		// `split(",")` cut here, inventing a cookie called
		// "21 Oct 2015 07:28:00 GMT" and truncating the real one's attributes.
		const parsed = parseSetCookie("id=a3fWa; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/");

		expect(parsed).toHaveLength(1);
		expect(parsed[0].name).toBe("id");
		expect(parsed[0].value).toBe("a3fWa");
		expect(parsed[0].attrs).toEqual(["Expires=Wed, 21 Oct 2015 07:28:00 GMT", "Path=/"]);
	});

	it("still separates genuinely distinct cookies", () => {
		const parsed = parseSetCookie("a=1; Path=/, b=2; Secure");

		expect(parsed.map((c) => [c.name, c.value])).toEqual([
			["a", "1"],
			["b", "2"],
		]);
	});

	it("separates cookies even when one of them carries a date", () => {
		const parsed = parseSetCookie(
			"session=xyz; Expires=Wed, 21 Oct 2015 07:28:00 GMT, theme=dark; Path=/"
		);

		expect(parsed.map((c) => c.name)).toEqual(["session", "theme"]);
		expect(parsed[0].attrs).toEqual(["Expires=Wed, 21 Oct 2015 07:28:00 GMT"]);
	});
});

describe("reading a cookie's value", () => {
	it("keeps base64 padding", () => {
		// `const [name, value] = pair.split("=")` returned "YWJjZGVm" and dropped
		// the "==" - so the value shown was not the value that was set.
		const parsed = parseSetCookie("session=YWJjZGVm==; HttpOnly");

		expect(parsed[0].value).toBe("YWJjZGVm==");
	});

	it("keeps an equals sign anywhere in the value", () => {
		expect(parseSetCookie("q=a=b=c")[0].value).toBe("a=b=c");
	});

	it("drops a chunk that names no cookie", () => {
		expect(parseSetCookie("=novalue")).toEqual([]);
		expect(parseSetCookie("garbage")).toEqual([]);
	});
});

describe("what the table shows", () => {
	const rendered = (setCookie: string) =>
		render(<ResponseCookies headers={{ "set-cookie": setCookie }} />).container;

	it("shows the attributes it has always parsed", () => {
		// `attrs` was computed on every row and rendered nowhere. Path, HttpOnly
		// and SameSite are the reason this tab gets opened.
		const container = rendered("id=a3fWa; Path=/; HttpOnly; SameSite=Strict");

		expect(container.textContent).toContain("Path=/");
		expect(container.textContent).toContain("HttpOnly");
		expect(container.textContent).toContain("SameSite=Strict");
	});

	it("says so when a cookie carries no attributes", () => {
		expect(rendered("plain=1").textContent).toContain("none");
	});

	it("falls back to the empty state when nothing parses", () => {
		const container = render(
			<ResponseCookies headers={{ "set-cookie": "garbage" }} />
		).container;
		expect(container.textContent).toContain("No cookies in response");
	});

	it("reads the header under either spelling", () => {
		const container = render(<ResponseCookies headers={{ "Set-Cookie": "id=1" }} />).container;
		expect(container.textContent).toContain("id");
	});
});

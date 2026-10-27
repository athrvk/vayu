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
import { render } from "@/test/render-with-tooltips";
import type { RedirectHop } from "@/types/domain";
import ResponseCookies from "./ResponseCookies";
import { parseSetCookie, parseSetCookieLine } from "./parse-set-cookie";

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

	it("marks the Expires date with a time, the rest of the attribute text unchanged", () => {
		// The Headers tab does the same for the same response (#1786); both go
		// through `HeaderValue`.
		const container = rendered("id=a3fWa; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/");

		const times = container.querySelectorAll("time");
		expect(times).toHaveLength(1);
		expect(times[0].textContent).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
		const chip = times[0].parentElement;
		expect(chip?.textContent).toBe("Expires=Wed, 21 Oct 2026 07:28:00 GMT");
		expect(container.textContent).toContain("Path=/");
	});

	it("gives an attribute that holds no time no time element", () => {
		expect(rendered("id=a3fWa; Path=/; HttpOnly").querySelector("time")).toBeNull();
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

describe("one cookie per received line (issue #2460)", () => {
	const LINES = [
		{ name: "Set-Cookie", value: "a=1; Path=/" },
		{ name: "set-cookie", value: "b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT" },
		{ name: "SET-COOKIE", value: "prefs=a=1, theme=dark; Path=/" },
		{ name: "Content-Type", value: "text/plain" },
	];
	// What the engine folds the same three lines into.
	const FOLDED = {
		"set-cookie":
			"a=1; Path=/, b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT, prefs=a=1, theme=dark; Path=/",
		"content-type": "text/plain",
	};

	const rows = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("tbody tr")).map(
			(tr) => tr.querySelectorAll("td")[0].textContent
		);

	it("shows three rows for three lines, a comma in a value included", () => {
		// The folded text splits into four here: "prefs=a=1, theme=dark" reads as
		// two cookies, the second named "theme".
		const { container } = render(<ResponseCookies headers={FOLDED} headerLines={LINES} />);

		expect(rows(container)).toEqual(["a", "b", "prefs"]);
		expect(container.textContent).toContain("a=1, theme=dark");
	});

	it("matches the name without regard to case and ignores other headers", () => {
		const { container } = render(
			<ResponseCookies
				headers={{}}
				headerLines={[{ name: "X-Set-Cookie-Like", value: "z=9" }, ...LINES.slice(0, 1)]}
			/>
		);

		expect(rows(container)).toEqual(["a"]);
	});

	it("trusts the lines over the folded map when they hold no cookie", () => {
		const { container } = render(<ResponseCookies headers={FOLDED} headerLines={[LINES[3]]} />);

		expect(container.textContent).toContain("No cookies in response");
	});

	it("splits the folded header only when there are no lines", () => {
		const { container } = render(<ResponseCookies headers={FOLDED} />);

		// The legacy guess: four rows, the fourth the phantom "theme".
		expect(rows(container)).toEqual(["a", "b", "prefs", "theme"]);
	});

	it("parses a line without splitting it", () => {
		expect(parseSetCookieLine("prefs=a=1, theme=dark; Path=/")).toEqual({
			name: "prefs",
			value: "a=1, theme=dark",
			attrs: ["Path=/"],
		});
		expect(parseSetCookieLine("garbage")).toBeNull();
	});
});

describe("cookies set during redirects (issue #2461)", () => {
	const HOP_LOGIN = {
		status: 302,
		statusText: "Found",
		headerLines: [
			{ name: "Set-Cookie", value: "session=abc; Path=/; HttpOnly" },
			{ name: "Location", value: "/home" },
		],
	};
	const HOP_QUIET = {
		status: 301,
		statusText: "Moved Permanently",
		headerLines: [{ name: "Location", value: "/login" }],
	};
	const HOP_SECOND = {
		status: 307,
		statusText: "Temporary Redirect",
		headerLines: [
			{ name: "set-cookie", value: "theme=dark, prefs=a=1" },
			{ name: "Set-Cookie", value: "lang=en" },
		],
	};
	const FINAL = [{ name: "Set-Cookie", value: "final=1" }];

	const rows = (root: ParentNode) =>
		Array.from(root.querySelectorAll("tbody tr")).map(
			(tr) => tr.querySelectorAll("td")[0].textContent
		);
	const labels = (container: HTMLElement) =>
		Array.from(container.querySelectorAll('[data-slot="eyebrow"]')).map((e) => e.textContent);

	it("lists a hop's cookie under 'Set during redirects' with the hop's status and Location", () => {
		const { container } = render(
			<ResponseCookies headers={{}} headerLines={[]} redirects={[HOP_LOGIN]} />
		);

		expect(labels(container)).toEqual(["Set during redirects"]);
		expect(container.textContent).toContain("302 Found, to /home");
		expect(rows(container)).toEqual(["session"]);
		expect(container.textContent).toContain("HttpOnly");
	});

	it("keeps the final response's cookies in their own group beside the hops'", () => {
		const { container } = render(
			<ResponseCookies headers={{}} headerLines={FINAL} redirects={[HOP_LOGIN]} />
		);

		expect(labels(container)).toEqual(["Set by this response", "Set during redirects"]);
		const [finalGroup, hopGroup] = Array.from(container.querySelectorAll("section"));
		expect(rows(finalGroup)).toEqual(["final"]);
		expect(rows(hopGroup)).toEqual(["session"]);
	});

	it("gives each hop that set a cookie its own sub-heading and table, in order", () => {
		const { container } = render(
			<ResponseCookies
				headers={{}}
				headerLines={[]}
				redirects={[HOP_LOGIN, HOP_QUIET, HOP_SECOND]}
			/>
		);

		const hopGroup = container.querySelectorAll("section")[0];
		const headings = Array.from(hopGroup.querySelectorAll("p.font-mono")).map(
			(p) => p.textContent
		);
		// The quiet hop set nothing, so it has no heading either; a hop with no
		// Location is named by its status alone.
		expect(headings).toEqual(["302 Found, to /home", "307 Temporary Redirect"]);
		const tables = Array.from(hopGroup.querySelectorAll("table"));
		expect(tables.map((t) => rows(t))).toEqual([["session"], ["theme", "lang"]]);
	});

	it("reads a hop's lines one cookie per line, a comma in a value included", () => {
		const { container } = render(
			<ResponseCookies headers={{}} redirects={[HOP_SECOND]} headerLines={[]} />
		);

		expect(rows(container)).toEqual(["theme", "lang"]);
		expect(container.textContent).toContain("dark, prefs=a=1");
	});

	it("never calls a hop's cookie stored", () => {
		const { container } = render(
			<ResponseCookies headers={{}} headerLines={FINAL} redirects={[HOP_LOGIN]} />
		);

		expect(container.textContent?.toLowerCase()).not.toContain("stored");
	});

	it("shows the one table, unlabelled, when no hop set a cookie", () => {
		const { container } = render(
			<ResponseCookies headers={{}} headerLines={FINAL} redirects={[HOP_QUIET]} />
		);

		expect(labels(container)).toEqual([]);
		expect(rows(container)).toEqual(["final"]);
	});

	it("says there are none only when neither group has a cookie", () => {
		const none = render(
			<ResponseCookies headers={{}} headerLines={[]} redirects={[HOP_QUIET]} />
		).container;
		expect(none.textContent).toContain("No cookies in response");

		const hopsOnly = render(
			<ResponseCookies headers={{}} headerLines={[]} redirects={[HOP_LOGIN]} />
		).container;
		expect(hopsOnly.textContent).not.toContain("No cookies in response");
	});
});

describe("an https to http redirect (issue #2949)", () => {
	const QUIET_DOWNGRADE = {
		status: 301,
		statusText: "Moved Permanently",
		headerLines: [{ name: "Location", value: "/plain" }],
		url: "https://api.example.com/start",
		schemeDowngrade: true,
	};
	const COOKIE_DOWNGRADE = {
		status: 302,
		statusText: "Found",
		headerLines: [
			{ name: "Set-Cookie", value: "session=abc; Path=/" },
			{ name: "Location", value: "http://api.example.com/home" },
		],
		url: "https://api.example.com/login",
		schemeDowngrade: true,
	};
	const SAME_SCHEME = { ...QUIET_DOWNGRADE, schemeDowngrade: false };
	const OLD_ENGINE = {
		status: 301,
		statusText: "Moved Permanently",
		headerLines: [{ name: "Location", value: "/plain" }],
	};

	const NOTICE = "Redirected from https to http";
	const show = (redirects: RedirectHop[], headerLines = [{ name: "Set-Cookie", value: "f=1" }]) =>
		render(<ResponseCookies headers={{}} headerLines={headerLines} redirects={redirects} />)
			.container;

	it("warns about a downgrade that set no cookie, naming the hop's url and Location", () => {
		const container = show([QUIET_DOWNGRADE], []);

		expect(container.textContent).toContain(NOTICE);
		expect(container.textContent).toContain(
			"301 Moved Permanently from https://api.example.com/start, to /plain"
		);
		// No cookie group, but the empty state still says what the tab holds.
		expect(container.textContent).toContain("No cookies in response");
		expect(container.querySelectorAll("table")).toHaveLength(0);
	});

	it("says nothing when the hop stayed on its scheme", () => {
		expect(show([SAME_SCHEME]).textContent).not.toContain(NOTICE);
	});

	it("says nothing for a hop from an engine that records no downgrade flag", () => {
		const container = show([OLD_ENGINE], []);
		expect(container.textContent).not.toContain(NOTICE);
		expect(container.textContent).toContain("No cookies in response");
	});

	it("lists only the downgrading hops when the chain mixes them", () => {
		const container = show([SAME_SCHEME, COOKIE_DOWNGRADE], []);

		const items = Array.from(container.querySelectorAll("li")).map((li) => li.textContent);
		expect(items).toEqual([
			"302 Found from https://api.example.com/login, to http://api.example.com/home",
		]);
	});

	it("keeps the cookie groups beside the notice", () => {
		const container = show([COOKIE_DOWNGRADE]);

		expect(container.textContent).toContain(NOTICE);
		expect(
			Array.from(container.querySelectorAll('[data-slot="eyebrow"]')).map(
				(e) => e.textContent
			)
		).toEqual(["Set by this response", "Set during redirects"]);
		expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
	});

	it("labels a cookie hop with the resolved url when the engine sent one", () => {
		const container = show([{ ...COOKIE_DOWNGRADE, schemeDowngrade: false }], []);

		expect(container.querySelector("section p.font-mono")?.textContent).toBe(
			"302 Found from https://api.example.com/login, to http://api.example.com/home"
		);
	});
});

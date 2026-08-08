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
 * The cookie section filters by host, and says that host filtering is an
 * approximation.
 *
 * The label is not decoration. libcurl applies the full domain/path/secure
 * matching at transfer time, so this list can be a superset of what is actually
 * attached; a section that presented it as the answer would be confidently
 * wrong on exactly the cases a user is debugging when they open it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CookiesSection } from "./CookiesSection";
import { cookieMatchesHost, hostOf } from "./cookie-host";
import type { EngineCookie, GetCookiesResponse } from "@/types";

const clearMutate = vi.fn();
let cookiesData: GetCookiesResponse | undefined;

vi.mock("@/queries/cookies", () => ({
	useCookiesQuery: () => ({ data: cookiesData, isLoading: false }),
	useClearCookiesMutation: () => ({ mutate: clearMutate, isPending: false }),
}));

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: { id: "req_1", collectionId: "col_1", url: REQUEST_URL } }),
}));

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

vi.mock("@/stores", () => ({
	useSessionStore: (selector: (s: { activeEnvironmentId: string | null }) => unknown) =>
		selector({ activeEnvironmentId: "env_1" }),
}));

let REQUEST_URL = "https://api.example.com/v1/users";

const cookie = (name: string, domain: string, path = "/"): EngineCookie => ({
	name,
	value: "v",
	domain,
	path,
	secure: false,
	httpOnly: false,
	expires: 0,
});

const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

const renderSection = () => render(<CookiesSection tab={TAB} />);

beforeEach(() => {
	clearMutate.mockReset();
	REQUEST_URL = "https://api.example.com/v1/users";
	cookiesData = {
		scopes: [
			{
				environmentId: "env_1",
				cookies: [
					cookie("session", "api.example.com"),
					cookie("wide", ".example.com"),
					cookie("elsewhere", "other.test"),
					// A near-miss that a naive `endsWith` on the bare domain
					// accepts: "notexample.com" ends with "example.com".
					cookie("lookalike", "notexample.com"),
				],
			},
			{ environmentId: "env_other", cookies: [cookie("wrong-jar", "api.example.com")] },
		],
	};
});

describe("host matching", () => {
	it("reads the host out of a URL and null out of anything else", () => {
		expect(hostOf("https://API.Example.com/v1")).toBe("api.example.com");
		// A URL being typed is the ordinary case, not an error.
		expect(hostOf("https://{{host}}/v1")).toBe("{{host}}");
		expect(hostOf("api.example.com/v1")).toBeNull();
		expect(hostOf("")).toBeNull();
	});

	it("accepts the exact host and a dotted parent domain, and nothing adjacent", () => {
		expect(cookieMatchesHost(cookie("c", "api.example.com"), "api.example.com")).toBe(true);
		expect(cookieMatchesHost(cookie("c", ".example.com"), "api.example.com")).toBe(true);
		expect(cookieMatchesHost(cookie("c", "example.com"), "api.example.com")).toBe(true);
		// The boundary: a bare `endsWith` would call this a match.
		expect(cookieMatchesHost(cookie("c", "notexample.com"), "api.example.com")).toBe(false);
		expect(cookieMatchesHost(cookie("c", "api.example.com"), "example.com")).toBe(false);
	});
});

describe("CookiesSection", () => {
	it("lists only this host's cookies, from this environment's jar", () => {
		renderSection();

		expect(screen.getByText("session")).toBeInTheDocument();
		expect(screen.getByText("wide")).toBeInTheDocument();
		expect(screen.queryByText("elsewhere")).not.toBeInTheDocument();
		expect(screen.queryByText("lookalike")).not.toBeInTheDocument();
		// The jar is per environment; another environment's is a different jar,
		// not more of this one.
		expect(screen.queryByText("wrong-jar")).not.toBeInTheDocument();
	});

	it("labels the approximation and points at the exact answer", () => {
		renderSection();
		expect(screen.getByText(/libcurl decides what is finally attached/)).toBeInTheDocument();
	});

	it("clears the jar for the active environment", () => {
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: /Clear jar/ }));
		expect(clearMutate).toHaveBeenCalledWith({ environmentId: "env_1" });
	});

	it("says nothing is held rather than showing an empty list", () => {
		cookiesData = { scopes: [] };
		renderSection();
		expect(screen.getByText("No cookies held for this host")).toBeInTheDocument();
		// Nothing to clear, so no button that would do nothing.
		expect(screen.queryByRole("button", { name: /Clear jar/ })).not.toBeInTheDocument();
	});

	it("says the request has no host yet rather than listing every cookie", () => {
		REQUEST_URL = "not a url";
		renderSection();
		expect(screen.getByText("This request has no host yet")).toBeInTheDocument();
		expect(screen.queryByText("session")).not.toBeInTheDocument();
	});
});

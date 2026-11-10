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
 * The "Sends" line is the URL that reaches the server (#3425): the fragment
 * libcurl never sends is cut, and an API key placed in the query - the request's
 * own or one it inherits from a folder - is appended as the engine appends it.
 * The key's value is a credential, so it is masked on the line like any secret.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { Collection } from "@/types";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import ParamsPanel from "./ParamsPanel";
import { fieldResolverOf } from "@/test/variable-support";
import { withQueryClient } from "@/test/query-wrapper";

vi.mock("@/services/api", () => ({
	apiService: { composeRequest: vi.fn().mockResolvedValue({}) },
}));

// The chain a request sits in, root-first, which the panel reads for `inherit`.
let ancestors: Collection[] = [];
vi.mock("@/queries/collections", () => ({
	useCollectionAncestors: () => ancestors,
}));

afterEach(() => {
	cleanup();
	ancestors = [];
});

const resolve = (s: string) =>
	s.replace(/{{(\w+)}}/g, (_m, name: string) => (name === "base" ? "https://x" : ""));

function sendsLine(url: string, overrides: Partial<RequestState> = {}): string {
	const value = {
		request: {
			...createDefaultRequestState(),
			id: `req_${url}_${JSON.stringify(overrides.auth)}`,
			url,
			params: [],
			...overrides,
		},
		updateField: () => {},
		resolveString: resolve,
		resolveField: fieldResolverOf(resolve),
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: () => {},
		writableScopes: [],
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
	const { container } = render(
		withQueryClient(
			<TooltipProvider>
				<RequestBuilderContext.Provider value={value}>
					<ParamsPanel />
				</RequestBuilderContext.Provider>
			</TooltipProvider>
		)
	);
	const label = [...container.querySelectorAll("span")].find((el) => el.textContent === "Sends");
	return label?.nextElementSibling?.textContent ?? "";
}

const queryKey = { mode: "apikey", key: "api_key", value: "s3cr3t", in: "query" } as const;

describe("the Sends line", () => {
	it("cuts the fragment", () => {
		expect(sendsLine("{{base}}/s?q=1#frag")).toBe("https://x/s?q=1");
	});

	it("adds an API key placed in the query, its value masked", () => {
		expect(sendsLine("{{base}}/s?q=1#frag", { auth: queryKey })).toBe(
			"https://x/s?q=1&api_key=••••"
		);
	});

	it("adds the API key a request inherits from its chain, its value masked", () => {
		ancestors = [{ id: "folder", auth: queryKey } as unknown as Collection];
		const line = sendsLine("{{base}}/s", { auth: { mode: "inherit" } });
		expect(line).toBe("https://x/s?api_key=••••");
		expect(line).not.toContain("s3cr3t");
	});

	it("adds nothing for an API key placed in a header", () => {
		expect(sendsLine("{{base}}/s", { auth: { ...queryKey, in: "header" } })).toBe(
			"https://x/s"
		);
	});

	it("adds nothing for an `inherit` request whose chain has no auth", () => {
		expect(sendsLine("{{base}}/s", { auth: { mode: "inherit" } })).toBe("https://x/s");
	});
});

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

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { Collection, RequestAuth } from "@/types";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import ParamsPanel from "./ParamsPanel";
import { fieldResolverOf } from "@/test/variable-support";
import { withQueryClient } from "@/test/query-wrapper";

const composeRequest = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: { composeRequest: (...args: unknown[]) => composeRequest(...args) },
}));

// The chain a request sits in, root-first, which the panel reads for `inherit`.
let ancestors: Collection[] = [];
vi.mock("@/queries/collections", () => ({
	useCollectionAncestors: () => ancestors,
}));

beforeEach(() => composeRequest.mockResolvedValue({}));

afterEach(() => {
	cleanup();
	ancestors = [];
});

type Variables = Record<string, { value: string; secret?: boolean }>;

/** Resolves what `variables` holds and leaves any other `{{name}}` as written. */
const resolverOf = (variables: Variables) => (s: string) =>
	s.replace(/{{(\w+)}}/g, (token, name: string) =>
		name === "base" ? "https://x" : (variables[name]?.value ?? token)
	);

function sendsLine(
	url: string,
	overrides: Partial<RequestState> = {},
	variables: Variables = {}
): string {
	const resolve = resolverOf(variables);
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
		getAllVariables: () => variables,
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

function lineNow(): string {
	const label = screen.getByText("Sends");
	return label.nextElementSibling?.textContent ?? "";
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

describe("the Sends line's API key is masked as it was resolved and trimmed", () => {
	const inQuery = (value: string): RequestAuth => ({
		mode: "apikey",
		key: "api_key",
		value,
		in: "query",
	});
	const plain = { apiKey: { value: "abc123" } };

	it("hides a variable's value whether or not the variable is marked secret", () => {
		for (const secret of [false, true]) {
			const line = sendsLine(
				"{{base}}/s",
				{ auth: inQuery("{{apiKey}}") },
				{ apiKey: { value: "abc123", secret } }
			);
			expect(line).toBe("https://x/s?api_key=••••");
		}
	});

	it("hides a value built around a variable", () => {
		const line = sendsLine("{{base}}/s", { auth: inQuery("pre-{{apiKey}}") }, plain);
		expect(line).toBe("https://x/s?api_key=••••");
	});

	it("hides a secret variable whose padding the engine trims off", () => {
		const line = sendsLine(
			"{{base}}/s",
			{ auth: inQuery("{{apiKey}}") },
			{ apiKey: { value: "  tok3n \t", secret: true } }
		);
		expect(line).toBe("https://x/s?api_key=••••");
		expect(line).not.toContain("tok3n");
	});

	it("hides a variable-held key a folder places in the query", () => {
		ancestors = [{ id: "folder", auth: inQuery("{{apiKey}}") } as unknown as Collection];
		const line = sendsLine("{{base}}/s", { auth: { mode: "inherit" } }, plain);
		expect(line).toBe("https://x/s?api_key=••••");
	});

	it("hides it where it lands unencoded as well", () => {
		const line = sendsLine(
			"{{base}}/s",
			{ auth: inQuery("{{apiKey}}"), disableUrlEncoding: true },
			{ apiKey: { value: "a b&c" } }
		);
		expect(line).toBe("https://x/s?api_key=••••");
	});

	it("shows a name nothing resolves as written, since that is what goes out", () => {
		const line = sendsLine("{{base}}/s", { auth: inQuery("{{missing}}") });
		expect(line).toBe("https://x/s?api_key={{missing}}");
	});

	it("shows a name a pre-request script sets as written, and says so", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["apiKey"] });
		const line = sendsLine("{{base}}/s", { auth: inQuery("{{apiKey}}") }, plain);
		expect(
			await screen.findByText("{{apiKey}} is set by a pre-request script at send.")
		).toBeInTheDocument();
		expect(lineNow()).toBe("https://x/s?api_key={{apiKey}}");
		// The first paint was before the engine answered: the stored value, masked.
		expect(line).toBe("https://x/s?api_key=••••");
	});
});

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
 * An OAuth 2.0 token placed in the query and a GraphQL GET's document are on the
 * wire too (#3437): the token is drawn as a masked stand-in, and a secret
 * variable inside the document is masked where it lands encoded.
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

describe("the Sends line's OAuth 2.0 token placed in the query (#3437)", () => {
	const oauth2 = (config: Record<string, unknown>): RequestAuth =>
		({ mode: "oauth2", config }) as unknown as RequestAuth;

	it("adds the parameter with the token masked, under the default name", () => {
		const line = sendsLine("{{base}}/s?q=1", { auth: oauth2({ tokenPlacement: "query" }) });
		expect(line).toBe("https://x/s?q=1&access_token=••••");
	});

	it("adds it under the configured name", () => {
		const auth = oauth2({ tokenPlacement: "query", queryParamName: "tok" });
		expect(sendsLine("{{base}}/s", { auth })).toBe("https://x/s?tok=••••");
	});

	it("adds it for the OAuth 2.0 a request inherits from its chain", () => {
		ancestors = [
			{
				id: "folder",
				auth: oauth2({ tokenPlacement: "query", queryParamName: "tok" }),
			} as unknown as Collection,
		];
		expect(sendsLine("{{base}}/s", { auth: { mode: "inherit" } })).toBe("https://x/s?tok=••••");
	});

	it("adds nothing for a header placement", () => {
		const auth = oauth2({ tokenPlacement: "header", queryParamName: "tok" });
		expect(sendsLine("{{base}}/s", { auth })).toBe("https://x/s");
	});

	it("shows a name a pre-request script sets as written", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["param"] });
		const auth = oauth2({ tokenPlacement: "query", queryParamName: "{{param}}" });
		sendsLine("{{base}}/s", { auth }, { param: { value: "stored" } });
		expect(
			await screen.findByText("{{param}} is set by a pre-request script at send.")
		).toBeInTheDocument();
		expect(lineNow()).toBe("https://x/s?{{param}}=••••");
	});
});

describe("the Sends line's GraphQL GET (#3437)", () => {
	const graphql = (content: string): Partial<RequestState> => ({
		method: "GET",
		bodyMode: "graphql",
		body: content,
	});

	it("carries the document as the query parameter the engine sends", () => {
		expect(sendsLine("{{base}}/g?a=1#top", graphql("{ me }"))).toBe(
			"https://x/g?a=1&query=%7B%20me%20%7D"
		);
	});

	it("carries an envelope's members, its variables resolved before they are encoded", () => {
		const line = sendsLine(
			"{{base}}/g",
			graphql('{"query":"{ me }","variables":{"id":"{{userId}}"}}'),
			{ userId: { value: "u 1" } }
		);
		expect(line).toBe(
			"https://x/g?query=%7B%20me%20%7D&variables=%7B%22id%22%3A%22u%201%22%7D"
		);
	});

	it("masks a secret variable in the document where it lands encoded", () => {
		const line = sendsLine("{{base}}/g", graphql('{ login(pw: "{{pw}}") }'), {
			pw: { value: "hunter2", secret: true },
		});
		expect(line).toBe("https://x/g?query=%7B%20login%28pw%3A%20%22••••%22%29%20%7D");
		expect(line).not.toContain("hunter2");
	});

	it("masks a secret variable in an envelope's variables, whose value needs encoding", () => {
		const line = sendsLine(
			"{{base}}/g",
			graphql('{"query":"{ me }","variables":{"pw":"{{pw}}"}}'),
			{ pw: { value: "p@ss w&rd", secret: true } }
		);
		expect(line).toBe("https://x/g?query=%7B%20me%20%7D&variables=%7B%22pw%22%3A%22••••%22%7D");
		expect(line).not.toMatch(/p%40ss|p@ss/);
	});

	it("adds nothing for a POST, whose document stays in the body", () => {
		expect(sendsLine("{{base}}/g", { ...graphql("{ me }"), method: "POST" })).toBe(
			"https://x/g"
		);
	});

	it("adds nothing for a GET with any other body mode", () => {
		expect(sendsLine("{{base}}/g", { method: "GET", bodyMode: "json", body: "{ me }" })).toBe(
			"https://x/g"
		);
	});
});

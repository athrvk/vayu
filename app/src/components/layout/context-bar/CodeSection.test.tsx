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
 * The Code section's two promises, both of which are policy rather than markup.
 *
 * **It generates from the composed request**, not from the stored template - so
 * the snippet shows the value a `{{host}}` resolved to and the auth an
 * `inherit` walked to. Generating from the stored request instead is the
 * failure mode the whole section exists to avoid, and it would look right on
 * screen.
 *
 * **Secrets are masked until asked for.** Resolved output substitutes real
 * values into a string the user is about to paste somewhere, so the default has
 * to be hidden. Templated output cannot contain a resolved secret at all,
 * because it never resolves anything - the last case pins that, since a
 * regression there would leak the value into the mode that looks safest.
 *
 * The generators themselves are covered in `services/codegen/codegen.test.ts`;
 * this file is about which input reaches them and with what options.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { CodeSection } from "./CodeSection";
import type { ResolvedVariable } from "@/types";

const composeRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		composeRequest: (...args: unknown[]) => composeRequest(...args),
	},
}));

/** The stored request: a `{{host}}` and an `inherit`, neither resolved. */
const STORED = {
	id: "req_1",
	collectionId: "col_1",
	method: "POST",
	url: "https://{{host}}/v1/users",
	headers: [
		{ key: "X-Token", value: "{{token}}", enabled: true },
		{ key: "X-Off", value: "no", enabled: false },
	],
	body: { mode: "json", content: '{"a":1}' },
	auth: { mode: "inherit" },
};

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: STORED }),
	useCollectionAncestors: () => [],
}));

const resolved: Record<string, ResolvedVariable> = {
	host: { value: "api.example.com", scope: "global" },
	token: { value: "s3cret-token", scope: "environment", sourceId: "env_1", secret: true },
};

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({
		getAllVariables: () => resolved,
		resolveString: (s: string) => s,
		resolveObject: <T,>(o: T) => o,
	}),
}));

vi.mock("@/stores", () => ({
	useSessionStore: (selector: (s: { activeEnvironmentId: string | null }) => unknown) =>
		selector({ activeEnvironmentId: "env_1" }),
}));

const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

function renderSection() {
	return render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<CodeSection tab={TAB} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

function snippet(): string {
	return document.querySelector("pre")!.textContent ?? "";
}

beforeEach(() => {
	composeRequest.mockReset();
	composeRequest.mockResolvedValue({
		method: "POST",
		url: "https://api.example.com/v1/users",
		headers: { "X-Token": "s3cret-token" },
		body: { mode: "json", content: '{"a":1}' },
		auth: { mode: "bearer", token: "inherited-bearer" },
	});
});

describe("CodeSection - it generates from what will be sent", () => {
	it("composes for the active environment and uses the resolved payload", async () => {
		renderSection();

		await waitFor(() => expect(snippet()).toContain("curl"));
		expect(composeRequest).toHaveBeenCalledWith({ requestId: "req_1", environmentId: "env_1" });
		// The resolved host, not `{{host}}` - the difference between a Vayu
		// snippet and a template-based one.
		expect(snippet()).toContain("https://api.example.com/v1/users");
		expect(snippet()).not.toContain("{{host}}");
		// The inherited auth the engine walked, applied as a header: the engine
		// keeps `auth` beside the request and attaches it at send time, so a
		// snippet built from the composed headers alone would not authenticate.
		expect(snippet()).toContain("Authorization: Bearer");
	});

	it("switches language without recomposing", async () => {
		renderSection();
		await waitFor(() => expect(snippet()).toContain("curl"));

		fireEvent.click(screen.getByRole("radio", { name: "JS fetch" }));

		await waitFor(() => expect(snippet()).toContain("await fetch("));
		// One compose for both languages - the payload is the same request.
		expect(composeRequest).toHaveBeenCalledTimes(1);
	});

	it("says so when composing fails instead of showing a stale snippet", async () => {
		composeRequest.mockRejectedValue(new Error("engine not running"));
		renderSection();

		expect(await screen.findByText(/Couldn't compose this request/)).toBeInTheDocument();
		expect(document.querySelector("pre")).toBeNull();
	});
});

describe("CodeSection - the secret policy", () => {
	it("masks resolved secrets by default and says it did", async () => {
		renderSection();

		await waitFor(() => expect(snippet()).toContain("curl"));
		// `token` is a secret variable and the bearer credential is a secret by
		// virtue of being a credential; neither may be on screen unasked.
		expect(snippet()).not.toContain("s3cret-token");
		expect(snippet()).not.toContain("inherited-bearer");
		expect(snippet()).toContain("<secret>");
		expect(screen.getByText(/Secrets are hidden/)).toBeInTheDocument();
	});

	it("reveals them only on an explicit act", async () => {
		renderSection();
		await waitFor(() => expect(snippet()).toContain("<secret>"));

		fireEvent.click(screen.getByRole("button", { name: "Reveal secrets" }));

		await waitFor(() => expect(snippet()).toContain("s3cret-token"));
		expect(snippet()).toContain("inherited-bearer");
		expect(screen.queryByText(/Secrets are hidden/)).not.toBeInTheDocument();
	});

	it("never puts a resolved secret in templated output", async () => {
		renderSection();
		await waitFor(() => expect(snippet()).toContain("curl"));

		fireEvent.click(screen.getByRole("radio", { name: "Templated" }));

		await waitFor(() => expect(snippet()).toContain("{{host}}"));
		// The template is the request as written: the token reference, never the
		// value behind it, whichever way the reveal toggle was left.
		expect(snippet()).toContain("{{token}}");
		expect(snippet()).not.toContain("s3cret-token");
		expect(snippet()).not.toContain("inherited-bearer");
		// Disabled header rows are not sent, so they are not in the snippet.
		expect(snippet()).not.toContain("X-Off");
		// Nothing to hide, so no reveal control to offer.
		expect(screen.queryByRole("button", { name: /secrets/i })).not.toBeInTheDocument();
	});
});

describe("CodeSection - the fidelity it cannot promise", () => {
	it("states that jar cookies are not in the snippet", async () => {
		renderSection();
		await waitFor(() => expect(snippet()).toContain("curl"));
		// libcurl attaches them at transfer time, so they are not in the composed
		// payload and cannot be in a static command.
		expect(screen.getByText(/Cookies from the jar/)).toBeInTheDocument();
	});
});

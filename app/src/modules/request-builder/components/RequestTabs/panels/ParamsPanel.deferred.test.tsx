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
 * The "Sends" line and a name a pre-request script sets at send (#2741).
 *
 * `POST /compose` leaves such a name written and lists it in
 * `deferredVariables` (#2521); the line must then draw it as written instead of
 * as the stored value, and say why, in the Code section's own words. The
 * renderer holds no rule for which requests are scripted - every case here
 * varies only the engine's answer - and a literal URL never asks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { queryKeys } from "@/queries/keys";
import { useSessionStore } from "@/stores";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { fieldResolverOf } from "@/test/variable-support";
import ParamsPanel from "./ParamsPanel";

const composeRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: { composeRequest: (...args: unknown[]) => composeRequest(...args) },
}));

const STORED: Record<string, string> = { host: "api.test", token: "stored-token" };
const resolve = (text: string) =>
	text.replace(/{{(\w+)}}/g, (token, name: string) => STORED[name] ?? token);

const URL = "https://{{host}}/v1?t={{token}}";

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function panel(url: string, id: string | undefined, client: QueryClient) {
	const value = {
		request: { ...createDefaultRequestState(), id, url, params: [] },
		updateField: () => {},
		resolveString: resolve,
		resolveField: fieldResolverOf(resolve),
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: () => {},
		writableScopes: [],
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
	return (
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<RequestBuilderContext.Provider value={value}>
					<ParamsPanel />
				</RequestBuilderContext.Provider>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** The text on the Sends line, which is the sibling of its label. */
function sendsText(container: HTMLElement): string {
	const label = [...container.querySelectorAll("span")].find((el) => el.textContent === "Sends");
	return label?.nextElementSibling?.textContent ?? "";
}

const HINT = /pre-request script at send/;

/** Waits until the engine's answer for `req_1` under `env_1` is in the cache. */
async function answered(client: QueryClient) {
	const key = queryKeys.compose.forRequest("req_1", "env_1", "saved");
	await waitFor(() => expect(client.getQueryState(key)?.status).toBe("success"));
}

beforeEach(() => {
	composeRequest.mockReset();
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
});

afterEach(cleanup);

describe("the Sends line for a name a pre-request script sets", () => {
	it("draws it as written, resolves the rest, and says a script sets it", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		const { container } = render(panel(URL, "req_1", newClient()));

		expect(
			await screen.findByText("{{token}} is set by a pre-request script at send.")
		).toBeInTheDocument();
		expect(sendsText(container)).toBe("https://api.test/v1?t={{token}}");
		// The stored value is not what will be sent, so it is not on the line.
		expect(container.textContent).not.toContain("stored-token");
	});

	it("names each deferred name the URL uses, and none it does not", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["host", "other", "token"] });
		const { container } = render(panel(URL, "req_1", newClient()));

		expect(
			await screen.findByText("{{host}}, {{token}} are set by a pre-request script at send.")
		).toBeInTheDocument();
		expect(sendsText(container)).toBe("https://{{host}}/v1?t={{token}}");
	});

	it("says nothing about a name the engine deferred that the URL never uses", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["unused"] });
		const client = newClient();
		const { container } = render(panel(URL, "req_1", client));

		await answered(client);
		expect(sendsText(container)).toBe("https://api.test/v1?t=stored-token");
		expect(screen.queryByText(HINT)).toBeNull();
	});

	it("is the line it always was when the engine deferred nothing", async () => {
		composeRequest.mockResolvedValue({});
		const client = newClient();
		const { container } = render(panel(URL, "req_1", client));

		await answered(client);
		expect(sendsText(container)).toBe("https://api.test/v1?t=stored-token");
		expect(screen.queryByText(HINT)).toBeNull();
	});

	it("reads the entry the Code section composed, without composing again", () => {
		const client = newClient();
		// The key the Code section files a request no builder holds under.
		client.setQueryData(queryKeys.compose.forRequest("req_1", "env_1", "saved"), {
			payload: {},
			deferredVariables: ["token"],
			editorSettings: null,
		});
		const { container } = render(panel(URL, "req_1", client));

		expect(sendsText(container)).toBe("https://api.test/v1?t={{token}}");
		expect(screen.getByText(HINT)).toBeInTheDocument();
		expect(composeRequest).not.toHaveBeenCalled();
	});

	it("re-reads the answer for another environment", async () => {
		const client = newClient();
		client.setQueryData(queryKeys.compose.forRequest("req_1", "env_2", "saved"), {
			payload: {},
			deferredVariables: ["token"],
			editorSettings: null,
		});
		composeRequest.mockResolvedValue({});
		const { container } = render(panel(URL, "req_1", client));

		// env_1 is active and has no entry, so it composes itself and finds none.
		await waitFor(() => expect(composeRequest).toHaveBeenCalledTimes(1));
		expect(sendsText(container)).toBe("https://api.test/v1?t=stored-token");
	});
});

describe("what the Sends line costs", () => {
	it("composes nothing for a URL with no token, however many it renders", async () => {
		composeRequest.mockResolvedValue({});
		const literal = render(panel("https://api.test/v1?page=1", "req_literal", newClient()));
		// A request that does ask, as the control: a call is observable, and the
		// literal one's absence is then read against it, not against a delay.
		render(panel(URL, "req_tokened", newClient()));

		await waitFor(() => expect(composeRequest).toHaveBeenCalledTimes(1));
		expect(composeRequest).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "req_tokened" })
		);
		expect(sendsText(literal.container)).toBe("https://api.test/v1?page=1");
	});

	it("composes nothing for a request with no id, which there is nothing to compose by", async () => {
		composeRequest.mockResolvedValue({});
		const unsaved = render(panel(URL, undefined, newClient()));
		render(panel(URL, "req_control", newClient()));

		await waitFor(() => expect(composeRequest).toHaveBeenCalledTimes(1));
		expect(composeRequest).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "req_control" })
		);
		expect(sendsText(unsaved.container)).toBe("https://api.test/v1?t=stored-token");
	});

	it("does not compose again when the panel comes back to a cached answer", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		const client = newClient();
		const first = render(panel(URL, "req_1", client));
		await screen.findByText(HINT);
		first.unmount();

		// Params -> Headers -> Params unmounts and remounts the panel.
		render(panel(URL, "req_1", client));

		expect(screen.getByText(HINT)).toBeInTheDocument();
		expect(composeRequest).toHaveBeenCalledTimes(1);
	});
});

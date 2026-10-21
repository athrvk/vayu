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
 * What the MCP focus mirror publishes as a tab's label, driven through the real
 * `useTabDescriptors` (issue #2045). A tab titled from a URL carries resolved
 * variable values, so it must publish its kind; a tab the user named publishes
 * that name, whatever shape the name has. `isPath` cannot tell the two apart:
 * a URL that does not parse is shown as written, with no leading slash, and a
 * request named "/orders" has one.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { DEFAULT_REQUEST_NAME } from "@/constants/request";

const REQUESTS: Record<
	string,
	{ id: string; name: string; method: string; url: string; params: [] }
> = {
	unparseable: {
		id: "unparseable",
		name: "",
		method: "GET",
		url: "abc123secret/users",
		params: [],
	},
	templated: { id: "templated", name: "", method: "GET", url: "{{x}}.host/y", params: [] },
	parsed: {
		id: "parsed",
		name: "",
		method: "GET",
		url: "https://api.test/orders/s3cret",
		params: [],
	},
	placeholder: {
		id: "placeholder",
		name: "New Request",
		method: "GET",
		url: "abc123secret/users",
		params: [],
	},
	slashNamed: {
		id: "slashNamed",
		name: "/orders",
		method: "POST",
		url: "https://api.test/x",
		params: [],
	},
	named: {
		id: "named",
		name: "Create order",
		method: "POST",
		url: "abc123secret/users",
		params: [],
	},
};

const RUNS: Record<string, { id: string; type: string; configSnapshot: { url: string } }> = {
	runParsed: {
		id: "runParsed",
		type: "design",
		configSnapshot: { url: "https://api.test/orders/s3cret" },
	},
	runUnparseable: {
		id: "runUnparseable",
		type: "load",
		configSnapshot: { url: "abc123secret/users" },
	},
};

const NO_COLLECTIONS: unknown[] = [];
const NO_ENVIRONMENTS: unknown[] = [];
const EMPTY_GLOBALS = { variables: {} };

vi.mock("@/queries", () => ({
	requestDetailOptions: (id: string | null) => ({
		queryKey: ["request", id],
		queryFn: async () => (id ? REQUESTS[id] : undefined),
		initialData: id ? REQUESTS[id] : undefined,
		enabled: false,
	}),
	runDetailOptions: (id: string | null) => ({
		queryKey: ["run", id],
		queryFn: async () => (id ? RUNS[id] : undefined),
		initialData: id ? RUNS[id] : undefined,
		enabled: false,
	}),
	useCollectionsQuery: () => ({ data: NO_COLLECTIONS }),
	useGlobalsQuery: () => ({ data: EMPTY_GLOBALS }),
	useEnvironmentsQuery: () => ({ data: NO_ENVIRONMENTS }),
	useInboxesQuery: () => ({ data: [] }),
	useMockServersQuery: () => ({ data: [] }),
}));

const { useTabDescriptors } = await import("./tab-descriptors");
const { focusTabLabel } = await import("@/hooks/useAppFocusMirror");

function publishedLabel(type: "request" | "run", entityId: string): string {
	const tab = { id: `t-${entityId}`, type, entityId };
	const { result } = renderHook(() => useTabDescriptors([tab]), {
		wrapper: ({ children }) => (
			<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
		),
	});
	return focusTabLabel(tab, result.current[0]);
}

describe("the label the focus mirror publishes", () => {
	it("keeps the placeholder name from counting as a name", () => {
		expect(REQUESTS.placeholder.name).toBe(DEFAULT_REQUEST_NAME);
	});

	it.each(["unparseable", "templated", "parsed", "placeholder"])(
		"publishes the kind for an unnamed request titled from its URL (%s)",
		(id) => {
			// Mutation check: key focusTabLabel on `isPath` and the first two fail.
			expect(publishedLabel("request", id)).toBe("Request");
		}
	);

	it.each([
		["slashNamed", "/orders"],
		["named", "Create order"],
	])("publishes the name the user gave (%s)", (id, name) => {
		// Mutation check: key focusTabLabel on `isPath` and "/orders" reads "Request".
		expect(publishedLabel("request", id)).toBe(name);
	});

	it.each(["runParsed", "runUnparseable"])(
		"publishes the kind for a run titled from its snapshot URL (%s)",
		(id) => {
			expect(publishedLabel("run", id)).toBe("Run");
		}
	);
});

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
 * The body introspects on its own only an endpoint the user has already
 * contacted. Introspection composes the request with the user's variables and
 * auth and sends it, so doing it for any URL that reaches the screen - one from
 * an imported file included - is contact nobody chose. Everything else offers
 * Load schema on the badge instead, and Refresh stays unconditional.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { buildSchema } from "graphql";
import { TooltipProvider } from "@/components/ui";
import { TIMING } from "@/config/timing";
import { useSchemaCache, type SchemaTarget } from "@/lib/graphql/schema-cache";
import { useClientSettingsStore } from "@/stores/client-settings-store";
import type { ComposedRequest } from "@/types";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));
vi.mock("@/lib/graphql/introspect", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/graphql/introspect")>()),
	composeIntrospection: vi.fn(),
	introspectSchema: vi.fn(),
}));

const { composeIntrospection, introspectSchema } = await import("@/lib/graphql/introspect");
const { GraphQLBody } = await import("./GraphQLBody");

const ORIGIN = "https://api.test";
const URL = `${ORIGIN}/gql`;
const TARGET: SchemaTarget = { url: URL, resolvedUrl: URL, headers: {}, resolvedAuth: null };
const schema = buildSchema("type Query { ping: String }");

function renderBody() {
	return render(
		<TooltipProvider>
			<GraphQLBody
				body=""
				onBodyChange={() => {}}
				requestId="r1"
				schemaTarget={TARGET}
				method="POST"
				variablesDraft={null}
				onVariablesDraftChange={() => {}}
			/>
		</TooltipProvider>
	);
}

/** Past the debounce, with the awaited compose and introspection settled. */
const pastDebounce = () =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(TIMING.GRAPHQL_INTROSPECTION_DEBOUNCE_MS);
	});

const loadSchemaButton = () => screen.queryByRole("button", { name: "Load schema" });
const approved = () => useClientSettingsStore.getState().approvedEndpoints;

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.mocked(composeIntrospection).mockResolvedValue({
		method: "POST",
		url: URL,
		headers: [],
	} as ComposedRequest);
	vi.mocked(introspectSchema).mockResolvedValue(schema);
	useSchemaCache.setState({ byKey: {}, lru: [], activeKey: null, awaitingLoad: {} });
	useClientSettingsStore.setState({ approvedEndpoints: [] });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("an endpoint the user has not contacted", () => {
	it("is not introspected, and the badge offers Load schema", async () => {
		renderBody();
		await pastDebounce();

		expect(introspectSchema).not.toHaveBeenCalled();
		expect(loadSchemaButton()).not.toBeNull();
	});

	it("loads on a click of Load schema, and approves the endpoint", async () => {
		renderBody();
		await pastDebounce();

		await act(async () => {
			fireEvent.click(loadSchemaButton()!);
		});

		expect(introspectSchema).toHaveBeenCalledTimes(1);
		expect(approved()).toEqual([ORIGIN]);
		expect(loadSchemaButton()).toBeNull();
	});

	it("loads once the user contacts it elsewhere, as Send on the request does", async () => {
		renderBody();
		await pastDebounce();
		expect(introspectSchema).not.toHaveBeenCalled();

		act(() => useClientSettingsStore.getState().approveEndpoint(ORIGIN));
		await pastDebounce();

		expect(introspectSchema).toHaveBeenCalledTimes(1);
		expect(loadSchemaButton()).toBeNull();
	});

	it("is not introspected when the request cannot be composed, and Load schema is still offered", async () => {
		vi.mocked(composeIntrospection).mockRejectedValue(new Error("variable not found"));
		useClientSettingsStore.setState({ approvedEndpoints: [ORIGIN] });
		renderBody();
		await pastDebounce();

		expect(introspectSchema).not.toHaveBeenCalled();
		expect(loadSchemaButton()).not.toBeNull();
	});
});

describe("an endpoint the user has already contacted", () => {
	it("is introspected on its own after the debounce, and not before", async () => {
		useClientSettingsStore.setState({ approvedEndpoints: [ORIGIN] });
		renderBody();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(TIMING.GRAPHQL_INTROSPECTION_DEBOUNCE_MS - 1);
		});
		expect(introspectSchema).not.toHaveBeenCalled();

		await pastDebounce();
		expect(introspectSchema).toHaveBeenCalledTimes(1);
		expect(loadSchemaButton()).toBeNull();
	});
});

describe("Refresh", () => {
	it("stays unconditional and approves the endpoint it reaches", async () => {
		renderBody();
		await pastDebounce();

		await act(async () => {
			fireEvent.click(screen.getByLabelText("Refresh schema"));
		});

		expect(introspectSchema).toHaveBeenCalledTimes(1);
		expect(approved()).toEqual([ORIGIN]);
	});
});

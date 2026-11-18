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
 * The builder's resolved-auth preview and the `jwt_bearer` signing key (#3632).
 *
 * `resolvedAuth` is the whole auth block through `resolveObject`, and the
 * renderer's resolver reads a secret variable's value like any other, so a
 * `privateKey` of `{{signing_key}}` would become the PEM in this memo and in
 * the GraphQL schema cache's identity digest. The key stays the reference, as
 * it does in every other host that resolves an OAuth 2.0 config.
 */

import { describe, it, expect, vi } from "vitest";
import { TestQueryClient } from "@/test/TestQueryClient";
import { act, renderHook } from "@testing-library/react";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";

const globals = { variables: {} as Record<string, unknown> };
const environments = [
	{
		id: "env",
		name: "Staging",
		variables: {
			signing_key: { value: PEM, enabled: true, secret: true },
			who: { value: "alice@example.test", enabled: true },
		},
	},
];
const session = { activeEnvironmentId: "env" as string | null };

vi.mock("@/queries", () => ({
	useElementKindsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: globals }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useEnvironmentsQuery: () => ({ data: environments }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: null, report: null, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
}));
vi.mock("@/stores", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores")>()),
	useSessionStore: (selector: (s: typeof session) => unknown) => selector(session),
	useResponseStore: (
		selector: (s: { getResponse: () => null; setResponse: ReturnType<typeof vi.fn> }) => unknown
	) => selector({ getResponse: () => null, setResponse: vi.fn() }),
}));
vi.mock("@/hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks")>();
	return { ...actual, useSaveManager: () => ({ saveStatus: "idle", isSaving: false }) };
});

const { default: RequestBuilderProvider } = await import("./RequestBuilderProvider");
const { useRequestBuilderContext } = await import("./RequestBuilderContext");

function setup() {
	return renderHook(() => useRequestBuilderContext(), {
		wrapper: ({ children }) => (
			<TestQueryClient>
				<RequestBuilderProvider collectionId={null} initialRequest={{ id: "req_a" }}>
					{children}
				</RequestBuilderProvider>
			</TestQueryClient>
		),
	}).result;
}

describe("the resolved-auth preview of a jwt_bearer request", () => {
	it("resolves the rest of the config and keeps the signing key a reference", () => {
		const result = setup();

		act(() =>
			result.current.setRequest({
				...result.current.request,
				auth: {
					mode: "oauth2",
					config: {
						grantType: "jwt_bearer",
						accessTokenUrl: "https://idp.test/token",
						clientId: "svc",
						subject: "{{who}}",
						privateKey: "{{signing_key}}",
					},
				},
			})
		);

		expect(result.current.resolvedAuth).toMatchObject({
			mode: "oauth2",
			config: { subject: "alice@example.test", privateKey: "{{signing_key}}" },
		});
		expect(JSON.stringify(result.current.resolvedAuth)).not.toContain("BEGIN");
	});
});

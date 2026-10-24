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
 * A request's Auth tab hands its token row the names a pre-request script may
 * change, because a Send resolves the config after the script (#2742). This tab
 * hands it none, and that is deliberate rather than missed: a collection has no
 * request to `POST /compose`, and the renderer holds no rule of its own for
 * "a pre-request script runs for requests under this collection" - the engine
 * answers it per send, over the request's own scripts and its `inherit.disable`
 * entries, neither of which a collection can see. A chain-only guess would read
 * "no script" for a request that scripts itself and "script" for one that
 * disables the inherited one, so the row keeps reporting the stored values'
 * token even where the chain holds an enabled `script.pre`.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import type { Collection, ElementDef } from "@/types";
import AuthTab from "./AuthTab";

const scripted: ElementDef = {
	id: "el_pre",
	kind: "script.pre",
	enabled: true,
	config: { script: "pm.environment.set('clientId', 'x')" },
};

function collection(overrides: Partial<Collection> = {}): Collection {
	return {
		id: "c1",
		name: "Acme API",
		description: "",
		order: 0,
		variables: {},
		auth: {
			mode: "oauth2",
			config: {
				grantType: "client_credentials",
				accessTokenUrl: "https://idp.example/token",
				clientId: "{{clientId}}",
			},
		},
		elements: [scripted],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

const parent = collection({ id: "root", name: "Root", elements: [scripted] });

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => ({
		mutateAsync: vi.fn(() => Promise.resolve()),
		mutate: vi.fn(),
		reset: vi.fn(),
		isPending: false,
		isError: false,
		error: null,
	}),
	// A scripted ancestor above a scripted collection.
	useCollectionAncestors: () => [parent],
}));

vi.mock("@/queries/oauth", () => ({
	useOAuth2TokenStatusQuery: () => ({
		data: {
			found: true,
			expired: false,
			token: { accessToken: "ya29.abcdefghijkl", expiresAt: null },
		},
	}),
	useFetchOAuth2TokenMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useClearOAuth2TokenMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

const useDeferredVariables = vi.fn(() => ["clientId"]);
vi.mock("@/components/layout/context-bar/code-composition", () => ({
	useDeferredVariables: () => useDeferredVariables(),
}));

describe("collection AuthTab's OAuth 2.0 token row under a scripted chain (#2742)", () => {
	it("keeps the ordinary token row: the editor has no request to ask the engine about", () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<AuthTab collection={collection()} />
				</TooltipProvider>
			</QueryClientProvider>
		);

		expect(screen.getByText("ya29…ijkl")).toBeInTheDocument();
		expect(screen.queryByText(/pre-request script/)).not.toBeInTheDocument();
		expect(useDeferredVariables).not.toHaveBeenCalled();
	});
});

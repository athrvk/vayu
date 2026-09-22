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
 * The effective OAuth 2.0 config this section hands `TokenStatusRow` used to be
 * resolved inline, in the component body, on every render - on the grounds that
 * the row keys its query on a *string* cache key, so a new object identity cost
 * one cheap re-derivation and nothing else.
 *
 * That holds for a `{{scope variable}}` and fails for a dynamic one.
 * `{{$guid}}` in the access-token URL or the client id resolves to something
 * new on every call (`lib/dynamic-variables.ts`'s own contract), and both of
 * those fields are *in* the cache key (`services/oauth/cache-key.ts`), so the
 * string changed too: a new query key on every render this section took for any
 * reason, which is a refetch loop rather than a re-derivation - and
 * `TokenStatusRow` re-hides a revealed token whenever that key changes.
 *
 * A `useMemo` and not `lib/dynamic-variable-cache.ts`'s module-scope cache,
 * for the reason `useHostCookies` (see `relevance.ts`) keeps one: this section
 * creates its own resolver, so a remount brings a fresh `resolveObject` that
 * would miss that cache anyway. The re-render is what is pinned here, because
 * it is the case that is answerable.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthContextSection } from "./AuthContextSection";
import type { RequestAuth } from "@/types";

const requestAuth: RequestAuth = {
	mode: "oauth2",
	config: {
		grantType: "client_credentials",
		accessTokenUrl: "https://idp.test/token",
		clientId: "client-{{$randomInt}}",
	},
};

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({
		data: { id: "req_1", collectionId: "col_leaf", auth: requestAuth },
		isLoading: false,
	}),
	useCollectionAncestors: () => [],
}));

/**
 * A resolver that behaves the way the dynamic-variable table does: every call
 * hands back a *different* value for the same input. Anything that resolves
 * twice therefore shows two different strings, which is the defect itself.
 *
 * One identity for the whole file, the way the real hook's `useCallback` keeps
 * one across the renders of a single mount - that identity is what the memo
 * below validates its entry against.
 */
let draws = 0;
const resolveObject = vi.fn(
	<T,>(o: T): T => JSON.parse(JSON.stringify(o).replace("{{$randomInt}}", String(++draws))) as T
);

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveObject }),
}));

vi.mock("@/components/shared/OAuth2Form", () => ({
	TokenStatusRow: ({ resolvedConfig }: { resolvedConfig: { clientId: string } }) => (
		<div data-testid="token-status">{resolvedConfig.clientId}</div>
	),
}));

const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

describe("the effective OAuth config", () => {
	it("is not re-resolved on a re-render with nothing about it changed", () => {
		const { rerender } = render(<AuthContextSection tab={TAB} />);
		const before = screen.getByTestId("token-status").textContent;
		// Sanity: the row really carries a generated value, not the raw token.
		expect(before).toMatch(/^client-\d+$/);
		const drawsAfterFirstRender = resolveObject.mock.calls.length;

		// A re-render triggered by something unrelated - a sibling section's
		// query settling, the bar re-rendering - must not draw again. A second
		// draw changes the client id, and with it the token cache key the row
		// queries on.
		rerender(<AuthContextSection tab={TAB} />);
		expect(screen.getByTestId("token-status").textContent).toBe(before);
		expect(resolveObject.mock.calls.length).toBe(drawsAfterFirstRender);
	});
});

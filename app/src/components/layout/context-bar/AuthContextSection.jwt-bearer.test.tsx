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
 * The context bar resolves the whole OAuth 2.0 config before it hands it to the
 * token row, and a `jwt_bearer` `privateKey` must come through as the reference
 * it was written as: the row's Get token sends this config, and the PEM belongs
 * to the engine (#3632). The request's collection rides along for the engine to
 * resolve it from.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { AuthContextSection } from "./AuthContextSection";
import type { OAuth2Config, RequestAuth } from "@/types";

const requestAuth: RequestAuth = {
	mode: "oauth2",
	config: {
		grantType: "jwt_bearer",
		accessTokenUrl: "https://idp.test/token",
		clientId: "svc",
		subject: "{{who}}",
		privateKey: "{{signing_key}}",
	},
};

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({
		data: { id: "req_1", collectionId: "col_leaf", auth: requestAuth },
		isLoading: false,
	}),
	useCollectionAncestors: () => [],
}));

const SCOPE: Record<string, string> = {
	who: "svc-user",
	signing_key: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
};
const resolveObject = <T,>(o: T): T =>
	JSON.parse(
		JSON.stringify(o).replace(VARIABLE_PATTERN, (_m, name: string) =>
			JSON.stringify(SCOPE[name]).slice(1, -1)
		)
	) as T;

vi.mock("@/hooks/useVariableResolver", () => ({ useVariableResolver: () => ({ resolveObject }) }));
vi.mock("./code-composition", () => ({ useDeferredVariables: () => [] }));

const row = vi.fn();
vi.mock("@/components/shared/OAuth2Form", () => ({
	TokenStatusRow: (props: { resolvedConfig: OAuth2Config; collectionId?: string }) => {
		row(props);
		return null;
	},
}));

describe("the context bar's token row for a jwt_bearer grant", () => {
	it("resolves the subject, keeps the key reference and names the request's collection", () => {
		render(<AuthContextSection tab={{ id: "t1", type: "request", entityId: "req_1" }} />);

		const props = row.mock.lastCall?.[0] as {
			resolvedConfig: OAuth2Config;
			collectionId: string;
		};
		expect(props.resolvedConfig.subject).toBe("svc-user");
		expect(props.resolvedConfig.privateKey).toBe("{{signing_key}}");
		expect(props.collectionId).toBe("col_leaf");
		expect(screen.queryByText(/BEGIN/)).toBeNull();
	});
});

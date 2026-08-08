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
 * Which auth goes out, and - the part worth having a section for - where it
 * came from.
 *
 * `inherit` is the only mode whose answer is not on the request, and the two
 * ways it resolves to "nothing" are different facts: no ancestor configured
 * any, versus an ancestor deliberately set to No Auth, which *terminates* the
 * walk. Collapsing those two into one sentence is what sends someone looking
 * for a missing credential in the wrong collection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthContextSection } from "./AuthContextSection";
import type { Collection, RequestAuth } from "@/types";

let requestAuth: RequestAuth = { mode: "inherit" };
let ancestors: Collection[] = [];

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({
		data: { id: "req_1", collectionId: "col_leaf", auth: requestAuth },
		isLoading: false,
	}),
	useCollectionAncestors: () => ancestors,
}));

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveObject: <T,>(o: T) => o }),
}));

vi.mock("@/components/shared/OAuth2Form", () => ({
	TokenStatusRow: ({ resolvedConfig }: { resolvedConfig: { clientId: string } }) => (
		<div data-testid="token-status">{resolvedConfig.clientId}</div>
	),
}));

const collection = (id: string, auth: Collection["auth"]): Collection => ({
	id,
	name: id,
	description: "",
	order: 0,
	variables: {},
	auth,
	preRequestScript: "",
	postRequestScript: "",
	createdAt: "",
	updatedAt: "",
});

const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

const renderSection = () => render(<AuthContextSection tab={TAB} />);

beforeEach(() => {
	requestAuth = { mode: "inherit" };
	ancestors = [];
});

describe("AuthContextSection", () => {
	it("names the request's own auth when it has one", () => {
		requestAuth = { mode: "bearer", token: "t" };
		renderSection();

		expect(screen.getByText("Bearer Token")).toBeInTheDocument();
		expect(screen.getByText("Set on this request")).toBeInTheDocument();
	});

	it("names the ancestor an inherit resolved to", () => {
		// Root → leaf; the nearest configured ancestor wins, which is why the
		// walk runs leaf-first and not root-first.
		ancestors = [
			collection("root", { mode: "basic", username: "u", password: "p" }),
			collection("leaf", { mode: "bearer", token: "t" }),
		];
		renderSection();

		expect(screen.getByText("Bearer Token")).toBeInTheDocument();
		expect(screen.getByText("Inherited from leaf")).toBeInTheDocument();
	});

	it("distinguishes a blocking No Auth from nobody having configured any", () => {
		ancestors = [
			collection("root", { mode: "bearer", token: "t" }),
			collection("leaf", { mode: "noauth" }),
		];
		renderSection();
		expect(screen.getByText(/leaf is set to No Auth/)).toBeInTheDocument();

		ancestors = [collection("root", { mode: "none" })];
		renderSection();
		expect(screen.getByText("No ancestor collection defines auth")).toBeInTheDocument();
	});

	it("steps past an ancestor with nothing configured", () => {
		// `none` means "nothing set here" and the walk continues; only `noauth`
		// stops it. Treating them alike is the classic version of this bug.
		ancestors = [
			collection("root", { mode: "bearer", token: "t" }),
			collection("leaf", { mode: "none" }),
		];
		renderSection();

		expect(screen.getByText("Inherited from root")).toBeInTheDocument();
	});

	it("shows the token status row for an OAuth 2.0 request, not a copy of it", () => {
		requestAuth = {
			mode: "oauth2",
			config: {
				grantType: "client_credentials",
				accessTokenUrl: "https://t",
				clientId: "cid",
			},
		};
		renderSection();

		expect(screen.getByTestId("token-status")).toHaveTextContent("cid");
	});

	it("shows no token row for any other mode", () => {
		requestAuth = { mode: "basic", username: "u", password: "p" };
		renderSection();
		expect(screen.queryByTestId("token-status")).not.toBeInTheDocument();
	});
});

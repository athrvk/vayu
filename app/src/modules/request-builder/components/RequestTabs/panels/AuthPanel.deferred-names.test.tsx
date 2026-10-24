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
 * A Send resolves the OAuth 2.0 config after the pre-request script, so the
 * Auth tab's token row must not report a token for the stored values when the
 * script may change a name the config uses (#2742). The panel is the host that knows
 * the request, so it asks for the names and hands them down through
 * `AuthFields` to the row; the collection editor, which has no request, hands
 * down nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import type { RequestAuth } from "@/types";
import AuthPanel from "./AuthPanel";

let engineDeferred: readonly string[] = [];
const useDeferredVariables = vi.fn((_requestId: string, _enabled: boolean) => engineDeferred);
vi.mock("@/components/layout/context-bar/code-composition", () => ({
	useDeferredVariables: (requestId: string, enabled: boolean) =>
		useDeferredVariables(requestId, enabled),
}));

vi.mock("@/queries/collections", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries/collections")>()),
	useCollectionAncestors: () => [],
}));

// The form has its own suites; here it only reports what the panel handed down.
vi.mock("@/components/shared/OAuth2Form", () => ({
	OAuth2Form: ({ deferredNames }: { deferredNames?: readonly string[] }) => (
		<div data-testid="oauth2-form" data-deferred={(deferredNames ?? []).join(",")} />
	),
}));

function oauth2(clientId: string): RequestAuth {
	return {
		mode: "oauth2",
		config: {
			grantType: "client_credentials",
			accessTokenUrl: "https://idp.test/token",
			clientId,
		},
	};
}

function renderPanel(auth: RequestAuth) {
	const request = { id: "req_1", auth, collectionId: null } as unknown as RequestState;
	const ctx = {
		request,
		updateField: vi.fn(),
		setRequest: vi.fn(),
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariable: () => null,
		resolveVariables: (s: string) => s,
		updateVariable: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={ctx}>
				<AuthPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

const deferredOnForm = () => screen.getByTestId("oauth2-form").getAttribute("data-deferred");

beforeEach(() => {
	engineDeferred = [];
	useDeferredVariables.mockClear();
});

describe("AuthPanel's token row when a pre-request script may change a name (#2742)", () => {
	it("hands the form the names a script may change that the config uses", () => {
		engineDeferred = ["clientId", "traceId"];
		renderPanel(oauth2("{{clientId}}"));

		expect(useDeferredVariables).toHaveBeenLastCalledWith("req_1", true);
		// "traceId" is the request's, not this config's.
		expect(deferredOnForm()).toBe("clientId");
	});

	it("hands the form nothing when the script's name is not in the config", () => {
		engineDeferred = ["traceId"];
		renderPanel(oauth2("{{clientId}}"));

		expect(deferredOnForm()).toBe("");
	});

	it("asks the engine nothing while the config is literal", () => {
		engineDeferred = ["clientId"];
		renderPanel(oauth2("cid"));

		expect(useDeferredVariables).toHaveBeenLastCalledWith("req_1", false);
		expect(deferredOnForm()).toBe("");
	});

	it("asks nothing for an auth mode that is not OAuth 2.0", () => {
		renderPanel({ mode: "none" });

		expect(useDeferredVariables).toHaveBeenLastCalledWith("req_1", false);
	});
});

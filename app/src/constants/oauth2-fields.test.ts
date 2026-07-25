/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The fixtures below are the engine's OAuth 2.0 error strings copied verbatim:
 *
 *   engine/src/http/oauth_client.cpp:211        accessTokenUrl must be an http(s) URL
 *   engine/src/http/oauth_client.cpp:214        clientId is required
 *   engine/src/http/oauth_client.cpp:219-220    Unsupported grantType: <grant>
 *   engine/src/http/routes/oauth_authorize.cpp:176  authorizationUrl and clientId are required
 *   engine/src/http/routes/oauth_authorize.cpp:199  callbackUrl is required for embedded mode
 *
 * This is a **snapshot, not a contract**. Nothing here fails if the C++ side
 * rewords a message - no cross-language guard is feasible, and the engine is
 * free to reword, since it answers MCP and curl clients as well as this UI. What
 * the test does hold is that every field name the engine currently emits comes
 * out as the label the form puts on that field. If a message changes, the worst
 * case degrades to today's behaviour: the raw identifier passes through.
 */

import { describe, it, expect } from "vitest";
import { OAUTH2_FIELD_LABELS, humanizeOAuth2Error } from "./oauth2-fields";

describe("humanizeOAuth2Error over the engine's own messages", () => {
	it.each([
		["accessTokenUrl must be an http(s) URL", "Access Token URL must be an http(s) URL"],
		["clientId is required", "Client ID is required"],
		["Unsupported grantType: password", "Unsupported Grant Type: password"],
		[
			"authorizationUrl and clientId are required",
			"Authorization URL and Client ID are required",
		],
		["callbackUrl is required for embedded mode", "Callback URL is required for embedded mode"],
	])("relabels %j", (engineMessage, expected) => {
		expect(humanizeOAuth2Error(engineMessage)).toBe(expected);
	});

	it("leaves a message naming no config field untouched", () => {
		// The engine emits this one too, and it names nothing the form labels.
		expect(humanizeOAuth2Error("Could not bind a local callback port")).toBe(
			"Could not bind a local callback port"
		);
	});

	it("passes a provider's own error through", () => {
		// A 401 body from the IdP is relayed as-is; it is the provider speaking,
		// and rewriting its vocabulary would misattribute the error to Vayu.
		const provider = "invalid_client: Client authentication failed";
		expect(humanizeOAuth2Error(provider)).toBe(provider);
	});

	it("does not rewrite a field name embedded in a longer identifier", () => {
		expect(humanizeOAuth2Error("clientIdentifier is unknown")).toBe(
			"clientIdentifier is unknown"
		);
	});
});

describe("the registry", () => {
	it("holds only fields the engine names in an error", () => {
		// Every extra key would be a label nothing reads - the "written but never
		// read" defect. Adding one means an engine message started naming it.
		expect(Object.keys(OAUTH2_FIELD_LABELS).sort()).toEqual([
			"accessTokenUrl",
			"authorizationUrl",
			"callbackUrl",
			"clientId",
			"grantType",
		]);
	});
});

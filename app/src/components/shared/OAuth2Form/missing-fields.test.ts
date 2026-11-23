/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { OAuth2Config } from "@/types";
import { missingOAuth2Fields } from "./missing-fields";

const AUTH_CODE: OAuth2Config = {
	grantType: "authorization_code",
	accessTokenUrl: "",
	clientId: "",
};

describe("missingOAuth2Fields with discovery (#3766)", () => {
	it("needs neither endpoint nor a client id once a server URL is typed", () => {
		expect(
			missingOAuth2Fields({ ...AUTH_CODE, discoverUrl: "https://mcp.example.com/mcp" })
		).toEqual([]);
	});

	it.each([
		["switched on with nothing typed", ""],
		["holding whitespace alone", "  "],
	])("names the server URL when discovery is %s", (_case, discoverUrl) => {
		expect(missingOAuth2Fields({ ...AUTH_CODE, discoverUrl })).toEqual(["Server URL"]);
	});

	it("names the endpoints and client id when discovery is off", () => {
		expect(missingOAuth2Fields(AUTH_CODE)).toEqual([
			"Authorization URL",
			"Access token URL",
			"Client ID",
		]);
	});

	it("ignores a discoverUrl on a grant with no sign-in", () => {
		expect(
			missingOAuth2Fields({
				...AUTH_CODE,
				grantType: "client_credentials",
				discoverUrl: "https://mcp.example.com/mcp",
			})
		).toEqual(["Access token URL", "Client ID"]);
	});
});

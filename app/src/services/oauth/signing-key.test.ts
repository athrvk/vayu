/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { OAuth2Config } from "@/types";
import {
	holdsPem,
	keepSigningKeyReference,
	singleReferenceName,
	tokenScopeIds,
} from "./signing-key";

const jwt: OAuth2Config = {
	grantType: "jwt_bearer",
	accessTokenUrl: "https://idp.test/token",
	clientId: "svc",
};

describe("holdsPem", () => {
	it.each([
		["a whole PEM", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", true],
		["an RSA PEM", "-----BEGIN RSA PRIVATE KEY-----", true],
		["a marker after other text", "{{a}} -----BEGIN EC PRIVATE KEY-----", true],
		["a reference", "{{signing_key}}", false],
		["an empty field", "", false],
	])("reads %s", (_name, text, expected) => {
		expect(holdsPem(text)).toBe(expected);
	});
});

describe("singleReferenceName", () => {
	it.each([
		["{{signing_key}}", "signing_key"],
		["  {{ signing_key }}  ", "signing_key"],
		["{{a}}{{b}}", null],
		["prefix {{a}}", null],
		["literal", null],
		[undefined, null],
	])("reads %j as %j", (text, expected) => {
		expect(singleReferenceName(text)).toBe(expected);
	});
});

describe("keepSigningKeyReference", () => {
	it("puts the key back as the raw config wrote it", () => {
		const raw = { ...jwt, privateKey: "{{signing_key}}" };
		const resolved = { ...raw, privateKey: "-----BEGIN PRIVATE KEY-----" };

		expect(keepSigningKeyReference(resolved, raw).privateKey).toBe("{{signing_key}}");
	});

	it("adds no member to a config that has no key", () => {
		const kept = keepSigningKeyReference({ ...jwt, privateKeyFile: "/k.pem" }, jwt);

		expect("privateKey" in kept).toBe(false);
		expect(kept.privateKeyFile).toBe("/k.pem");
	});
});

describe("tokenScopeIds", () => {
	it("names the scopes that are known and no others", () => {
		expect(tokenScopeIds("env", "col")).toEqual({ environmentId: "env", collectionId: "col" });
		expect(tokenScopeIds(null, "col")).toEqual({ collectionId: "col" });
		expect(tokenScopeIds("env", undefined)).toEqual({ environmentId: "env" });
		expect(tokenScopeIds("", null)).toEqual({});
	});
});

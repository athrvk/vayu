/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which tokens a collection run sends (issue #3199): one entry per distinct
 * cache key, found through the same auth walk a Send uses, with the variables of
 * the request's own collection chain resolved into the config.
 */

import { describe, it, expect } from "vitest";
import type { Collection, OAuth2Config, Request, RequestAuth } from "@/types";
import { computeOAuth2CacheKey } from "@/services/oauth/cache-key";
import { distinctRunOAuth2Configs, type RunRequestGroup } from "./runOAuth2Configs";

function oauth2(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
	return {
		grantType: "client_credentials",
		accessTokenUrl: "https://idp.test/token",
		clientId: "client-a",
		...overrides,
	};
}

function collection(
	id: string,
	parentId: string | null,
	auth: RequestAuth,
	variables: Collection["variables"] = {}
): Collection {
	return {
		id,
		name: id,
		...(parentId !== null ? { parentId } : {}),
		description: "",
		order: 0,
		variables,
		auth,
		elements: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

const requestWith = (auth: RequestAuth): Pick<Request, "auth"> => ({ auth });
const group = (collectionId: string, ...auths: RequestAuth[]): RunRequestGroup => ({
	collectionId,
	requests: auths.map(requestWith),
});

const NO_SCOPES = {};

describe("distinctRunOAuth2Configs", () => {
	it("finds a request's own OAuth 2.0 config", () => {
		const config = oauth2();
		const found = distinctRunOAuth2Configs(
			[group("c", { mode: "oauth2", config })],
			[collection("c", null, { mode: "none" })],
			NO_SCOPES
		);

		expect(found).toEqual([{ key: computeOAuth2CacheKey(config), config }]);
	});

	it("finds the config a request inherits from its collection chain", () => {
		const config = oauth2();
		const found = distinctRunOAuth2Configs(
			[group("leaf", { mode: "inherit" })],
			[
				collection("root", null, { mode: "oauth2", config }),
				collection("leaf", "root", { mode: "none" }),
			],
			NO_SCOPES
		);

		expect(found.map((entry) => entry.config)).toEqual([config]);
	});

	it("finds nothing under a No Auth ancestor, or for other auth modes", () => {
		const found = distinctRunOAuth2Configs(
			[
				group("public", { mode: "inherit" }),
				group("plain", { mode: "bearer", token: "t" }, { mode: "none" }),
			],
			[
				collection("root", null, { mode: "oauth2", config: oauth2() }),
				collection("public", "root", { mode: "noauth" }),
				collection("plain", "root", { mode: "none" }),
			],
			NO_SCOPES
		);

		expect(found).toEqual([]);
	});

	it("reports one entry for requests sharing a cache key, inherited or written out", () => {
		const shared = oauth2();
		const found = distinctRunOAuth2Configs(
			[
				group(
					"c",
					{ mode: "inherit" },
					{ mode: "inherit" },
					// A different object that keys the same: only the scope differs,
					// which the cache key leaves out.
					{ mode: "oauth2", config: oauth2({ scope: "read" }) }
				),
			],
			[collection("c", null, { mode: "oauth2", config: shared })],
			NO_SCOPES
		);

		expect(found).toHaveLength(1);
		expect(found[0].config).toEqual(shared);
	});

	it("reports one entry per distinct cache key, in first-seen order", () => {
		const a = oauth2();
		const otherClient = oauth2({ clientId: "client-b" });
		const otherCredentials = oauth2({ credentialsId: "second" });
		const found = distinctRunOAuth2Configs(
			[
				group("c", { mode: "oauth2", config: otherClient }, { mode: "inherit" }),
				group("d", { mode: "oauth2", config: otherCredentials }),
			],
			[
				collection("c", null, { mode: "oauth2", config: a }),
				collection("d", null, { mode: "none" }),
			],
			NO_SCOPES
		);

		expect(found.map((entry) => entry.config)).toEqual([otherClient, a, otherCredentials]);
		expect(new Set(found.map((entry) => entry.key)).size).toBe(3);
	});

	it("resolves variables through each request's own collection chain, globals and environment", () => {
		const templated = oauth2({
			accessTokenUrl: "{{idp}}/token",
			clientId: "{{client}}",
			credentialsId: "{{creds}}",
		});
		const found = distinctRunOAuth2Configs(
			[
				group("one", { mode: "oauth2", config: templated }),
				group("two", { mode: "oauth2", config: templated }),
			],
			[
				collection(
					"one",
					null,
					{ mode: "none" },
					{ client: { value: "client-one", enabled: true } }
				),
				collection(
					"two",
					null,
					{ mode: "none" },
					{ client: { value: "client-two", enabled: true } }
				),
			],
			{
				globals: { idp: { value: "https://idp.test" }, creds: { value: "from-globals" } },
				// Environment beats globals.
				environment: { creds: { value: "from-env" } },
			}
		);

		expect(found.map((entry) => entry.config)).toEqual([
			expect.objectContaining({
				accessTokenUrl: "https://idp.test/token",
				clientId: "client-one",
				credentialsId: "from-env",
			}),
			expect.objectContaining({ clientId: "client-two" }),
		]);
		// Two scopes, two tokens: the same written config is not one entry.
		expect(found[0].key).not.toBe(found[1].key);
	});

	it("merges configs that resolve to one key even when they are written differently", () => {
		const found = distinctRunOAuth2Configs(
			[
				group(
					"c",
					{ mode: "oauth2", config: oauth2({ clientId: "{{client}}" }) },
					{ mode: "oauth2", config: oauth2({ clientId: "client-a" }) }
				),
			],
			[
				collection(
					"c",
					null,
					{ mode: "none" },
					{ client: { value: "client-a", enabled: true } }
				),
			],
			NO_SCOPES
		);

		expect(found).toHaveLength(1);
	});

	it("leaves out a config with no token URL or client id once resolved", () => {
		const found = distinctRunOAuth2Configs(
			[
				group(
					"c",
					{ mode: "oauth2", config: oauth2({ accessTokenUrl: "" }) },
					{ mode: "oauth2", config: oauth2({ clientId: "" }) }
				),
			],
			[collection("c", null, { mode: "none" })],
			NO_SCOPES
		);

		expect(found).toEqual([]);
	});

	it("tolerates a group whose collection is not in the tree", () => {
		const config = oauth2();
		const found = distinctRunOAuth2Configs(
			[group("gone", { mode: "oauth2", config }, { mode: "inherit" })],
			[],
			NO_SCOPES
		);

		expect(found.map((entry) => entry.config)).toEqual([config]);
	});
});

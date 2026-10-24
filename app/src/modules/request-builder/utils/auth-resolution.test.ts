/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The inheritance walk, which decides what credentials leave the app.
 *
 * The case that matters most here is the difference between "no auth configured
 * at this level" (`none`, stepped over) and "configured to send nothing"
 * (`noauth`, terminal). Collapsing the two meant a request under a folder the
 * user had explicitly set to No Auth still sent the root collection's bearer
 * token - issue #195, finding 2. The engine walks the same chain in
 * `resolve_inherited_auth` (`engine/src/http/request_composer.cpp`) and has its
 * own tests; the two must stay in step.
 */

import { describe, it, expect } from "vitest";
import type { Collection, OAuth2Config } from "@/types";
import {
	effectiveOAuth2Config,
	oauth2DeferredNames,
	oauth2HasTokens,
	resolveAuthForSend,
	resolveAuthSource,
	resolveInheritedAuth,
} from "./auth-resolution";

function collection(id: string, auth: Collection["auth"]): Collection {
	return {
		id,
		name: id,
		description: "",
		order: 0,
		variables: {},
		auth,
		elements: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

const bearerRoot = collection("root", { mode: "bearer", token: "root-token" });

describe("resolveAuthSource", () => {
	it("takes the nearest ancestor that defines auth", () => {
		const chain = [
			bearerRoot,
			collection("mid", { mode: "basic", username: "u", password: "p" }),
			collection("leaf", { mode: "none" }),
		];

		expect(resolveAuthSource(chain).source?.id).toBe("mid");
		expect(resolveAuthSource(chain).blockedBy).toBeNull();
	});

	it("steps over a level with nothing configured", () => {
		const chain = [bearerRoot, collection("mid", { mode: "none" })];

		expect(resolveAuthSource(chain).source?.id).toBe("root");
	});

	it("stops at an ancestor explicitly set to noauth, and names it", () => {
		const chain = [
			bearerRoot,
			collection("public", { mode: "noauth" }),
			collection("leaf", { mode: "none" }),
		];

		const { source, blockedBy } = resolveAuthSource(chain);
		expect(source).toBeNull();
		expect(blockedBy?.id).toBe("public");
		expect(resolveInheritedAuth(chain)).toBeUndefined();
	});

	it("lets a nearer level re-add auth below a noauth ancestor", () => {
		// Termination is about what a descendant *inherits*, not a lock on the
		// subtree: a folder under the blocker may still define its own auth.
		const chain = [
			bearerRoot,
			collection("public", { mode: "noauth" }),
			collection("leaf", { mode: "bearer", token: "leaf-token" }),
		];

		expect(resolveAuthSource(chain).source?.id).toBe("leaf");
		expect(resolveInheritedAuth(chain)).toEqual({ mode: "bearer", token: "leaf-token" });
	});

	it("reports neither a source nor a blocker for an all-unset chain", () => {
		expect(resolveAuthSource([collection("a", { mode: "none" })])).toEqual({
			source: null,
			blockedBy: null,
		});
		expect(resolveAuthSource([])).toEqual({ source: null, blockedBy: null });
	});
});

describe("resolveAuthForSend", () => {
	it("sends nothing for a request under a blocked chain", () => {
		const chain = [bearerRoot, collection("public", { mode: "noauth" })];

		expect(resolveAuthForSend({ mode: "inherit" }, chain)).toBeUndefined();
	});

	it("sends the inherited block when nothing blocks it", () => {
		expect(resolveAuthForSend({ mode: "inherit" }, [bearerRoot])).toEqual({
			mode: "bearer",
			token: "root-token",
		});
	});

	it("sends nothing for a request whose own auth carries no credential", () => {
		// On the request itself the two modes coincide - its auth is never walked.
		expect(resolveAuthForSend({ mode: "none" }, [bearerRoot])).toBeUndefined();
		expect(resolveAuthForSend({ mode: "noauth" }, [bearerRoot])).toBeUndefined();
	});

	it("prefers the request's own concrete auth over the chain", () => {
		expect(resolveAuthForSend({ mode: "bearer", token: "own" }, [bearerRoot])).toEqual({
			mode: "bearer",
			token: "own",
		});
	});
});

describe("the OAuth 2.0 config a load run's guard judges", () => {
	const oauth2: OAuth2Config = {
		grantType: "client_credentials",
		accessTokenUrl: "https://auth.example.com/token",
		clientId: "{{clientId}}",
		scope: "read {{scope}}",
	};
	const oauth2Root = collection("root", { mode: "oauth2", config: oauth2 });

	it("is the request's own config, as written", () => {
		expect(effectiveOAuth2Config({ mode: "oauth2", config: oauth2 }, [])).toBe(oauth2);
	});

	it("is the inherited config when the request inherits", () => {
		const chain = [oauth2Root, collection("leaf", { mode: "none" })];

		expect(effectiveOAuth2Config({ mode: "inherit" }, chain)).toBe(oauth2);
	});

	it("is null when the effective auth is another mode, or an ancestor set No Auth", () => {
		expect(effectiveOAuth2Config({ mode: "bearer", token: "t" }, [oauth2Root])).toBeNull();
		expect(
			effectiveOAuth2Config({ mode: "inherit" }, [
				oauth2Root,
				collection("mid", { mode: "noauth" }),
			])
		).toBeNull();
	});

	it("reports a deferred name from any field, in the order first used", () => {
		expect(oauth2DeferredNames(oauth2, ["scope", "clientId"])).toEqual(["clientId", "scope"]);
	});

	it("leaves out a deferred name the OAuth 2.0 fields do not use", () => {
		// `token` is deferred for the request's header, not for the token request.
		expect(oauth2DeferredNames(oauth2, ["token"])).toEqual([]);
	});

	it("reads the config as written: a name with a stored value is still reported", () => {
		// The preview's resolved config would carry the stored value in its place.
		expect(oauth2DeferredNames({ ...oauth2, clientId: "{{clientId}}" }, ["clientId"])).toEqual([
			"clientId",
		]);
		expect(oauth2DeferredNames({ ...oauth2, clientId: "stored-id" }, ["clientId"])).toEqual([]);
	});

	it("reports nothing without a config", () => {
		expect(oauth2DeferredNames(null, ["clientId"])).toEqual([]);
	});

	it("asks for a composition only while a field holds a token", () => {
		expect(oauth2HasTokens(oauth2)).toBe(true);
		expect(oauth2HasTokens({ ...oauth2, clientId: "id", scope: "read" })).toBe(false);
		expect(oauth2HasTokens(null)).toBe(false);
	});
});

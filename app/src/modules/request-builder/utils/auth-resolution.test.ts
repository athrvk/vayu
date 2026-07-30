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
 * token - issue #195, finding 2. The MCP copy of this walk (`electron/mcp/
 * resolve.ts`) is pinned by the equivalent case in `resolve.test.ts`; the two
 * must stay in step.
 */

import { describe, it, expect } from "vitest";
import type { Collection } from "@/types";
import { resolveAuthForSend, resolveAuthSource, resolveInheritedAuth } from "./auth-resolution";

function collection(id: string, auth: Collection["auth"]): Collection {
	return {
		id,
		name: id,
		description: "",
		order: 0,
		variables: {},
		auth,
		preRequestScript: "",
		postRequestScript: "",
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

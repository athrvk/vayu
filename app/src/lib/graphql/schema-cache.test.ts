/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSchema } from "graphql";

vi.mock("./introspect", () => ({ introspectSchema: vi.fn() }));
import { introspectSchema } from "./introspect";
import { schemaCacheKey, useSchemaCache, type SchemaTarget } from "./schema-cache";

const schema = buildSchema("type Query { ping: String }");
const URL = "https://api.test/gql";
const TARGET: SchemaTarget = { url: URL, resolvedUrl: URL, headers: {} };

const entry = (target: SchemaTarget) => useSchemaCache.getState().byKey[schemaCacheKey(target)];

beforeEach(() => {
	vi.clearAllMocks();
	useSchemaCache.setState({ byKey: {}, activeKey: null });
});

describe("schema cache", () => {
	it("transitions idle → loading → ready on success", async () => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		const p = useSchemaCache.getState().ensureSchema(TARGET);
		expect(entry(TARGET).status).toBe("loading");
		await p;
		expect(entry(TARGET).status).toBe("ready");
		expect(entry(TARGET).schema).toBe(schema);
	});

	it("transitions to error on failure", async () => {
		vi.mocked(introspectSchema).mockRejectedValue(new Error("blocked"));
		await useSchemaCache.getState().ensureSchema(TARGET);
		expect(entry(TARGET).status).toBe("error");
		expect(entry(TARGET).error).toMatch(/blocked/);
	});

	it("does not re-introspect a target already ready", async () => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema(TARGET);
		await useSchemaCache.getState().ensureSchema(TARGET);
		expect(introspectSchema).toHaveBeenCalledTimes(1);
	});

	it("does not retry a target already in error (until the target changes)", async () => {
		vi.mocked(introspectSchema).mockRejectedValue(new Error("blocked"));
		await useSchemaCache.getState().ensureSchema(TARGET);
		await useSchemaCache.getState().ensureSchema(TARGET);
		expect(introspectSchema).toHaveBeenCalledTimes(1);
	});

	it("refreshSchema re-introspects even when already ready", async () => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema(TARGET);
		await useSchemaCache.getState().refreshSchema(TARGET);
		expect(introspectSchema).toHaveBeenCalledTimes(2);
		expect(entry(TARGET).status).toBe("ready");
	});

	it("getActiveSchema follows the active target", async () => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema(TARGET);
		expect(useSchemaCache.getState().getActiveSchema()).toBeNull();
		useSchemaCache.getState().setActiveTarget(TARGET);
		expect(useSchemaCache.getState().getActiveSchema()).toBe(schema);
		expect(useSchemaCache.getState().getActiveStatus()).toBe("ready");
	});
});

/*
 * The endpoint alone is not the identity. Introspection sends the request's
 * auth now, so a cached schema - or a cached 401 - belongs to the credentials
 * that fetched it. Each case below is one entry that used to collide.
 */
describe("cache identity", () => {
	const cases: [string, SchemaTarget][] = [
		["a different environment", { ...TARGET, environmentId: "env_2" }],
		["a different collection scope", { ...TARGET, collectionId: "col_2" }],
		["a different auth block", { ...TARGET, auth: { mode: "bearer", token: "b" } }],
		["a URL whose variables resolved elsewhere", { ...TARGET, resolvedUrl: "https://eu/gql" }],
	];

	it.each(cases)("re-introspects for %s", async (_label, other) => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema({ ...TARGET, environmentId: "env_1" });
		await useSchemaCache.getState().ensureSchema(other);
		expect(introspectSchema).toHaveBeenCalledTimes(2);
	});

	it("serves the entry of the active target, not of a same-URL neighbour", async () => {
		const other = { ...TARGET, environmentId: "env_2" };
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema({ ...TARGET, environmentId: "env_1" });

		useSchemaCache.getState().setActiveTarget(other);
		expect(useSchemaCache.getState().getActiveSchema()).toBeNull();
		expect(useSchemaCache.getState().getActiveStatus()).toBe("idle");
	});

	it("ignores a target with no endpoint", async () => {
		useSchemaCache.getState().setActiveTarget({ ...TARGET, url: "" });
		expect(useSchemaCache.getState().activeKey).toBeNull();
		await useSchemaCache.getState().ensureSchema({ ...TARGET, url: "" });
		expect(introspectSchema).not.toHaveBeenCalled();
	});
});

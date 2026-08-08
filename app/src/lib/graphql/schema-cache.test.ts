/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSchema } from "graphql";

vi.mock("./introspect", async (importOriginal) => ({
	...(await importOriginal<typeof import("./introspect")>()),
	introspectSchema: vi.fn(),
}));
import { introspectSchema, IntrospectionError } from "./introspect";
import {
	schemaCacheKey,
	useSchemaCache,
	SCHEMA_CACHE_MAX_ENTRIES,
	type SchemaTarget,
} from "./schema-cache";

const schema = buildSchema("type Query { ping: String }");
const URL = "https://api.test/gql";
const TARGET: SchemaTarget = { url: URL, resolvedUrl: URL, headers: {}, resolvedAuth: null };

const entry = (target: SchemaTarget) => useSchemaCache.getState().byKey[schemaCacheKey(target)];

beforeEach(() => {
	vi.clearAllMocks();
	useSchemaCache.setState({ byKey: {}, lru: [], activeKey: null });
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
		expect(entry(TARGET).error?.message).toMatch(/blocked/);
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
 * A failure the badge can act on. Every mode used to collapse into one static
 * "introspection failed" string, so "your token expired" and "this endpoint has
 * introspection switched off" - opposite fixes - were indistinguishable.
 */
describe("failure detail", () => {
	it("keeps the classified kind and the message, not just the fact of failing", async () => {
		vi.mocked(introspectSchema).mockRejectedValue(
			new IntrospectionError("auth", "The endpoint rejected these credentials (HTTP 401).")
		);
		await useSchemaCache.getState().ensureSchema(TARGET);
		expect(entry(TARGET).error).toEqual({
			kind: "auth",
			message: "The endpoint rejected these credentials (HTTP 401).",
		});
	});

	it("classifies a non-introspection throw as unknown rather than dropping it", async () => {
		vi.mocked(introspectSchema).mockRejectedValue(new Error("boom"));
		await useSchemaCache.getState().ensureSchema(TARGET);
		expect(entry(TARGET).error).toEqual({ kind: "unknown", message: "boom" });
	});

	it("stamps fetchedAt on a schema and leaves it null when there is none", async () => {
		vi.mocked(introspectSchema).mockRejectedValue(new Error("blocked"));
		await useSchemaCache.getState().ensureSchema(TARGET);
		expect(entry(TARGET).fetchedAt).toBeNull();

		vi.mocked(introspectSchema).mockResolvedValue(schema);
		await useSchemaCache.getState().refreshSchema(TARGET);
		expect(entry(TARGET).fetchedAt).toBeGreaterThan(0);
	});
});

/*
 * A refresh that fails does not make the schema the user was completing against
 * wrong. It used to null the schema entering `loading` and again on error, so
 * every manual refresh downgraded a working editor to syntax-only mid-flight,
 * and a failed one lost the schema for good.
 */
describe("keep-last-good", () => {
	it("keeps the schema completing while a refresh is in flight", async () => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema(TARGET);
		useSchemaCache.getState().setActiveTarget(TARGET);

		let release!: (s: typeof schema) => void;
		vi.mocked(introspectSchema).mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			})
		);
		const inFlight = useSchemaCache.getState().refreshSchema(TARGET);
		expect(useSchemaCache.getState().getActiveStatus()).toBe("loading");
		expect(useSchemaCache.getState().getActiveSchema()).toBe(schema);
		release(schema);
		await inFlight;
	});

	it("keeps the last good schema, and its age, across a failed refresh", async () => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema(TARGET);
		const fetchedAt = entry(TARGET).fetchedAt;

		vi.mocked(introspectSchema).mockRejectedValue(new IntrospectionError("auth", "401"));
		await useSchemaCache.getState().refreshSchema(TARGET);

		expect(entry(TARGET).status).toBe("error");
		expect(entry(TARGET).error?.kind).toBe("auth");
		// The schema is still the answer, and `fetchedAt` still dates *it* - not
		// the failure - so the badge can say how stale the completions are.
		expect(entry(TARGET).schema).toBe(schema);
		expect(entry(TARGET).fetchedAt).toBe(fetchedAt);
	});
});

/*
 * Every distinct (url, collection, environment, credential) combination used to
 * retain a fully built GraphQLSchema for the life of the process.
 */
describe("bounded cache", () => {
	const nth = (i: number): SchemaTarget => ({ ...TARGET, resolvedUrl: `${URL}/${i}` });

	it("evicts the least recently used entry past the cap", async () => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		for (let i = 0; i <= SCHEMA_CACHE_MAX_ENTRIES; i++) {
			await useSchemaCache.getState().ensureSchema(nth(i));
		}
		expect(Object.keys(useSchemaCache.getState().byKey)).toHaveLength(SCHEMA_CACHE_MAX_ENTRIES);
		// The first one fetched is the one gone; the newest is retained.
		expect(entry(nth(0))).toBeUndefined();
		expect(entry(nth(SCHEMA_CACHE_MAX_ENTRIES)).status).toBe("ready");
	});

	it("never evicts the entry the visible editor is completing against", async () => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema(nth(0));
		useSchemaCache.getState().setActiveTarget(nth(0));
		for (let i = 1; i <= SCHEMA_CACHE_MAX_ENTRIES; i++) {
			await useSchemaCache.getState().ensureSchema(nth(i));
		}
		expect(entry(nth(0)).schema).toBe(schema);
		expect(useSchemaCache.getState().getActiveSchema()).toBe(schema);
		expect(Object.keys(useSchemaCache.getState().byKey)).toHaveLength(SCHEMA_CACHE_MAX_ENTRIES);
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
		[
			"a different resolved credential",
			{ ...TARGET, resolvedAuth: { mode: "bearer", token: "b" } },
		],
		["a URL whose variables resolved elsewhere", { ...TARGET, resolvedUrl: "https://eu/gql" }],
	];

	it.each(cases)("re-introspects for %s", async (_label, other) => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema({ ...TARGET, environmentId: "env_1" });
		await useSchemaCache.getState().ensureSchema(other);
		expect(introspectSchema).toHaveBeenCalledTimes(2);
	});

	/*
	 * The exact #383 scenario: the request's auth block is untouched
	 * (`{{token}}`, or an `inherit` the user never edited) and the credential it
	 * resolves to changed upstream - an environment edit, an ancestor
	 * collection's auth. Keyed on the block as typed, this served the schema
	 * fetched with the old credential; keyed on what the wire will carry, it
	 * re-introspects.
	 */
	it("re-introspects when an upstream edit changes what the same auth block resolves to", async () => {
		vi.mocked(introspectSchema).mockResolvedValue(schema);
		const typed = { mode: "inherit" };
		await useSchemaCache.getState().ensureSchema({
			...TARGET,
			auth: typed,
			resolvedAuth: { mode: "bearer", token: "old_secret" },
		});
		await useSchemaCache.getState().ensureSchema({
			...TARGET,
			auth: typed,
			resolvedAuth: { mode: "bearer", token: "new_secret" },
		});
		expect(introspectSchema).toHaveBeenCalledTimes(2);
	});

	it("keeps the credential out of the key it writes", () => {
		const key = schemaCacheKey({
			...TARGET,
			resolvedAuth: { mode: "bearer", token: "sk_live" },
		});
		expect(key).not.toContain("sk_live");
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

describe("clearActiveTarget", () => {
	it("clears the target it names", () => {
		useSchemaCache.getState().setActiveTarget(TARGET);
		useSchemaCache.getState().clearActiveTarget(TARGET);
		expect(useSchemaCache.getState().activeKey).toBeNull();
	});

	/*
	 * A request switch mounts the next GraphQL body before the old one's cleanup
	 * runs. An unconditional clear would blank the target that was just set, so
	 * the new editor would complete against nothing.
	 */
	it("leaves a target another body has already set", () => {
		const next = { ...TARGET, resolvedUrl: "https://other.test/gql" };
		useSchemaCache.getState().setActiveTarget(next);
		useSchemaCache.getState().clearActiveTarget(TARGET);
		expect(useSchemaCache.getState().activeKey).toBe(schemaCacheKey(next));
	});
});

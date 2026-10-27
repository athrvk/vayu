/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `update_environment` and `update_collection` merge into a row another
 * client can write between their read and their PUT (#2433). Driven through
 * the real `EngineClient` against a fake engine that holds one row and judges
 * `If-Match` the way the engine does, so the header is what is under test.
 */

import { describe, expect, test } from "vitest";
import { EngineClient, entityTagOf } from "../engine-client.js";
import { resolveSafetyConfig } from "../config.js";
import { dispatchTool, type ToolContext } from "../tools.js";

type Row = Record<string, unknown> & {
	id: string;
	variables: Record<string, unknown>;
	updatedAt: number;
};

/** A write another client lands just before the next PUT is judged. */
type Edit = (row: Row) => Row;

interface Call {
	method: string;
	ifMatch: string | null;
	status: number;
}

function answer(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * One row listed at @p listPath and written at `<listPath>/<id>`. A PUT
 * first applies the next queued edit, then refuses an `If-Match` naming any
 * version but the stored one with the engine's 412, else merge-patches and
 * moves the version on.
 */
function fakeEngine(listPath: string, initial: Row, edits: Edit[]) {
	let row = initial;
	const calls: Call[] = [];
	const handle = (method: string, path: string, init?: RequestInit): Response => {
		if (method === "GET" && path === listPath) return answer(200, [row]);
		if (method !== "PUT" || path !== `${listPath}/${row.id}`) {
			return answer(404, { error: { code: "not_found", message: "Not found" } });
		}
		const edit = edits.shift();
		if (edit) row = edit(row);
		const ifMatch = new Headers(init?.headers).get("If-Match");
		if (ifMatch !== null && ifMatch !== entityTagOf(row)) {
			return answer(412, {
				error: {
					code: "precondition_failed",
					message: "The record changed after it was read",
					updatedAt: row.updatedAt,
				},
			});
		}
		row = { ...row, ...(JSON.parse(String(init?.body)) as Row), updatedAt: row.updatedAt + 1 };
		return answer(200, row);
	};
	const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const response = handle(method, new URL(String(input)).pathname, init);
		calls.push({
			method,
			ifMatch: new Headers(init?.headers).get("If-Match"),
			status: response.status,
		});
		return Promise.resolve(response);
	}) as typeof fetch;
	const ctx: ToolContext = {
		client: new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl }),
		config: resolveSafetyConfig({ allowWrites: true }),
		host: "app",
	};
	return { ctx, calls, stored: () => row };
}

const variable = (value: string) => ({ value, enabled: true });

/** The app's autosave changing one variable: a merge-patch onto the stored row. */
const appSets =
	(name: string, value: string): Edit =>
	(row) => ({
		...row,
		variables: { ...row.variables, [name]: variable(value) },
		updatedAt: row.updatedAt + 1,
	});

const environment = (): Row => ({
	id: "env_1",
	name: "Dev",
	variables: { baseUrl: variable("https://a.example") },
	updatedAt: 1_792_359_304_896,
});

describe("entityTagOf", () => {
	test("is the engine's weak tag of the row's updatedAt", () => {
		expect(entityTagOf({ updatedAt: 1_792_359_304_896 })).toBe('W/"1792359304896"');
	});

	test("is nothing for a row with no integer updatedAt", () => {
		expect(entityTagOf(null)).toBeUndefined();
		expect(entityTagOf({})).toBeUndefined();
		expect(entityTagOf({ updatedAt: "1" })).toBeUndefined();
		expect(entityTagOf({ updatedAt: 1.5 })).toBeUndefined();
	});
});

describe("update_environment under a concurrent edit", () => {
	// Mutation check: send no `If-Match` from `updateEnvironment` and the
	// first PUT lands the merge computed before the app's edit, so `token` is
	// gone from the stored row.
	test("re-reads once on a 412 and keeps the edit that landed in between", async () => {
		const engine = fakeEngine("/environments", environment(), [appSets("token", "from-app")]);

		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: "from-agent" } },
			engine.ctx
		);

		expect(res.isError).toBeFalsy();
		expect(engine.stored().variables).toEqual({
			baseUrl: variable("https://a.example"),
			token: variable("from-app"),
			apiKey: variable("from-agent"),
		});
		expect(engine.calls).toEqual([
			{ method: "GET", ifMatch: null, status: 200 },
			{ method: "PUT", ifMatch: 'W/"1792359304896"', status: 412 },
			{ method: "GET", ifMatch: null, status: 200 },
			{ method: "PUT", ifMatch: 'W/"1792359304897"', status: 200 },
		]);
	});

	test("writes once with the read's tag when nothing moved", async () => {
		const engine = fakeEngine("/environments", environment(), []);

		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: "from-agent" } },
			engine.ctx
		);

		expect(res.isError).toBeFalsy();
		expect(engine.calls.map(({ method, status }) => `${method} ${status}`)).toEqual([
			"GET 200",
			"PUT 200",
		]);
		expect(engine.calls[1].ifMatch).toBe('W/"1792359304896"');
	});

	test("reports a second 412 as a conflict and writes nothing", async () => {
		const engine = fakeEngine("/environments", environment(), [
			appSets("token", "first"),
			appSets("token", "second"),
		]);

		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: "from-agent" } },
			engine.ctx
		);

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(
			/^Nothing was written: environment "env_1" was changed/
		);
		expect(res.structuredContent).toMatchObject({
			error: { class: "transient", retryable: true },
		});
		expect(engine.calls.filter((c) => c.method === "PUT").map((c) => c.status)).toEqual([
			412, 412,
		]);
		expect(engine.stored().variables).not.toHaveProperty("apiKey");
	});

	test("sends no If-Match for a row that carries no updatedAt", async () => {
		const { updatedAt: _dropped, ...unversioned } = environment();
		const engine = fakeEngine("/environments", unversioned as Row, []);

		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: "from-agent" } },
			engine.ctx
		);

		expect(res.isError).toBeFalsy();
		expect(engine.calls[1]).toMatchObject({ method: "PUT", ifMatch: null });
	});
});

describe("update_collection under a concurrent edit", () => {
	const collection = (): Row => ({
		id: "col_1",
		name: "API",
		variables: { baseUrl: variable("https://a.example") },
		updatedAt: 1_792_359_304_896,
	});

	// Mutation check: send no `If-Match` from `updateCollection`.
	test("re-reads once on a 412 and keeps the edit that landed in between", async () => {
		const engine = fakeEngine("/collections", collection(), [appSets("token", "from-app")]);

		const res = await dispatchTool(
			"update_collection",
			{ collectionId: "col_1", variables: { apiKey: "from-agent" } },
			engine.ctx
		);

		expect(res.isError).toBeFalsy();
		expect(engine.stored().variables).toEqual({
			baseUrl: variable("https://a.example"),
			token: variable("from-app"),
			apiKey: variable("from-agent"),
		});
		expect(engine.calls.map(({ method, status }) => `${method} ${status}`)).toEqual([
			"GET 200",
			"PUT 412",
			"GET 200",
			"PUT 200",
		]);
	});

	test("a write naming only stated fields reads nothing and sends no If-Match", async () => {
		const engine = fakeEngine("/collections", collection(), []);

		const res = await dispatchTool(
			"update_collection",
			{ collectionId: "col_1", name: "Billing" },
			engine.ctx
		);

		expect(res.isError).toBeFalsy();
		expect(engine.calls).toEqual([{ method: "PUT", ifMatch: null, status: 200 }]);
	});
});

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one module that sends the grant secret (#2356): which calls carry it,
 * what a refusal and a dead engine answer, and that the names it uses are the
 * engine's own.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import {
	ENGINE_GRANT_SECRET_BYTES,
	ENGINE_GRANT_SECRET_ENV,
	ENGINE_GRANT_SECRET_HEADER,
} from "./constants";
import { createFileTrustClient, isRowId } from "./file-trust-client";

const ORIGIN = "http://127.0.0.1:9880";
const SECRET = "a".repeat(64);

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function clientAnswering(response: () => Response | Promise<Response>) {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response());
	const client = createFileTrustClient({ origin: () => ORIGIN, fetch });
	return { client, fetch };
}

function headersOf(fetch: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
	return ((fetch.mock.calls[call]?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<
		string,
		string
	>;
}

const ROW = { id: "fgrant_1", path: "/data/body.bin", createdAt: 1 };

describe("file trust writes", () => {
	it("records a grant with the secret, at the session's origin", async () => {
		const { client, fetch } = clientAnswering(() => json(201, ROW));
		client.setSecret(SECRET);

		await expect(client.createFileGrant("/data/body.bin")).resolves.toEqual({
			outcome: "done",
			value: ROW,
		});

		expect(fetch.mock.calls[0]?.[0]).toBe(`${ORIGIN}/file-grants`);
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({ path: "/data/body.bin" }),
		});
		expect(headersOf(fetch)[ENGINE_GRANT_SECRET_HEADER]).toBe(SECRET);
	});

	it("sends the secret on both folder writes, and the latest one after a restart", async () => {
		const { client, fetch } = clientAnswering(() => json(201, { ...ROW, id: "froot_1" }));
		client.setSecret(SECRET);
		await client.createFileRoot("/data");
		client.setSecret("b".repeat(64));
		await client.deleteFileRoot("froot_1");

		expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
			[`${ORIGIN}/file-roots`, "POST"],
			[`${ORIGIN}/file-roots/froot_1`, "DELETE"],
		]);
		expect(headersOf(fetch, 0)[ENGINE_GRANT_SECRET_HEADER]).toBe(SECRET);
		expect(headersOf(fetch, 1)[ENGINE_GRANT_SECRET_HEADER]).toBe("b".repeat(64));
	});

	it("does not send the secret on the read, which needs none", async () => {
		const { client, fetch } = clientAnswering(() => json(200, [ROW]));
		client.setSecret(SECRET);

		await expect(client.listFileGrants()).resolves.toEqual({ outcome: "done", value: [ROW] });
		expect(headersOf(fetch)[ENGINE_GRANT_SECRET_HEADER]).toBeUndefined();
	});

	it("does not call the engine for a write before any engine was spawned", async () => {
		const { client, fetch } = clientAnswering(() => json(201, ROW));

		await expect(client.createFileRoot("/data")).resolves.toMatchObject({
			outcome: "unreachable",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps the engine's status, code and message on a refusal", async () => {
		const { client } = clientAnswering(() =>
			json(409, {
				error: { code: "conflict", message: "The folder '/data' is already allowed" },
			})
		);
		client.setSecret(SECRET);

		await expect(client.createFileRoot("/data")).resolves.toEqual({
			outcome: "refused",
			status: 409,
			code: "conflict",
			message: "The folder '/data' is already allowed",
		});
	});

	it("answers unreachable, without throwing, when the engine does not answer", async () => {
		const { client } = clientAnswering(() => {
			throw new TypeError("fetch failed");
		});
		client.setSecret(SECRET);

		await expect(client.createFileGrant("/data/body.bin")).resolves.toEqual({
			outcome: "unreachable",
			message: "fetch failed",
		});
	});

	it("refuses an id that could leave the route, without calling the engine", async () => {
		const { client, fetch } = clientAnswering(() => json(200, { success: true }));
		client.setSecret(SECRET);

		for (const id of ["../file-grants/fgrant_1", "a/b", "", "froot_1?x=1", 7]) {
			await expect(client.deleteFileRoot(id as string)).resolves.toMatchObject({
				outcome: "refused",
				status: 400,
			});
		}
		expect(fetch).not.toHaveBeenCalled();
		expect(isRowId("froot_0123abcd")).toBe(true);
	});
});

/*
 * The app and the engine spell the secret's names separately and cannot share
 * a constant; a drift on either side makes every write a 403 with nothing
 * failing until a user presses Allow folder.
 */
describe("the grant secret's names match the engine's", () => {
	const [header] = ENGINE_READING_GUARDS.grantSecret.paths;
	const source = readFileSync(fromRepoRoot(header), "utf8");

	it("reads the engine's declarations", () => {
		expect(source.length).toBeGreaterThan(0);
		expect(source).toContain("GRANT_SECRET_HEADER");
	});

	it("names the same header and environment variable", () => {
		expect(/GRANT_SECRET_HEADER\s*=\s*"([^"]+)"/.exec(source)?.[1]).toBe(
			ENGINE_GRANT_SECRET_HEADER
		);
		expect(/GRANT_SECRET_ENV\s*=\s*"([^"]+)"/.exec(source)?.[1]).toBe(ENGINE_GRANT_SECRET_ENV);
	});

	it("mints a secret the engine does not ignore as too short", () => {
		const minimum = Number(/GRANT_SECRET_MIN_LENGTH\s*=\s*(\d+)/.exec(source)?.[1]);
		expect(minimum).toBeGreaterThan(0);
		// Sent as hex, two characters a byte.
		expect(ENGINE_GRANT_SECRET_BYTES * 2).toBeGreaterThanOrEqual(minimum);
	});
});

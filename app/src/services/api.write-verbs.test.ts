/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Payload-level guard for the create/update verb split (issue #95) and for
 * engine-owned ids (issue #97).
 *
 * The engine's `POST /<resource>` is create-only and answers a known id with a
 * 409; `PUT /<resource>/:id` is update-only and answers an unknown id with a
 * 404. Both used to be the same POST-as-upsert call, so nothing about a save
 * changes shape when this regresses - the renderer would simply start getting
 * 409s at runtime with every test still green. That makes this the only layer
 * that can catch it, so assert on the captured method, path and body rather
 * than on the returned object.
 *
 * The id is the *path*, not a body field, on both verbs: since #97 the engine
 * assigns every id and rejects a create carrying one with a 400, and a PUT whose
 * body id disagrees with the path is a 400 too. The renderer's types have no
 * `id` on a create, but only the captured body proves what a spread-through call
 * site actually sent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiService } from "./api";
import { httpClient } from "./http-client";

vi.mock("./http-client", () => ({
	httpClient: {
		get: vi.fn(),
		post: vi.fn(),
		put: vi.fn(),
		delete: vi.fn(),
	},
}));

const post = vi.mocked(httpClient.post);
const put = vi.mocked(httpClient.put);

describe("resource writes use POST to create and PUT to update", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// The transformers only need a plausible engine row back - they parse the
		// timestamps, so those have to be real.
		const row = {
			id: "x_1",
			name: "n",
			variables: {},
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
		};
		post.mockResolvedValue(row as never);
		put.mockResolvedValue(row as never);
	});

	it("creates a collection with POST /collections and no id in the path", async () => {
		await apiService.createCollection({ name: "New" });
		expect(put).not.toHaveBeenCalled();
		expect(post).toHaveBeenCalledWith("/collections", { name: "New" });
	});

	it("updates a collection with PUT /collections/:id, id in the path only", async () => {
		await apiService.updateCollection({ id: "col_1", name: "Renamed" });
		expect(post).not.toHaveBeenCalled();
		expect(put).toHaveBeenCalledWith("/collections/col_1", { name: "Renamed" });
		expect(put.mock.calls[0][1]).not.toHaveProperty("id");
	});

	it("sends parentId: null through to the wire for a move to the root", async () => {
		// Absent means "keep the parent" to the engine, so a move out of a folder
		// exists only as a null that survives serialization. `UpdateCollectionRequest.parentId`
		// was typed `string`, which made this call unwriteable rather than wrong.
		await apiService.updateCollection({ id: "col_1", parentId: null });
		expect(put).toHaveBeenCalledWith("/collections/col_1", { parentId: null });
		expect(JSON.stringify(put.mock.calls[0][1])).toContain('"parentId":null');
	});

	it("sends collectionId on a request update, so a move reaches the engine", async () => {
		await apiService.updateRequest({ id: "req_1", collectionId: "col_2" });
		expect(put).toHaveBeenCalledWith("/requests/req_1", { collectionId: "col_2" });
	});

	it("creates a request with POST /requests", async () => {
		await apiService.createRequest({
			collectionId: "col_1",
			name: "R",
			method: "GET",
			url: "https://example.com",
		});
		expect(put).not.toHaveBeenCalled();
		expect(post.mock.calls[0][0]).toBe("/requests");
	});

	it("updates a request with PUT /requests/:id, id in the path only", async () => {
		await apiService.updateRequest({ id: "req_1", url: "https://example.com/v2" });
		expect(post).not.toHaveBeenCalled();
		expect(put).toHaveBeenCalledWith("/requests/req_1", { url: "https://example.com/v2" });
		expect(put.mock.calls[0][1]).not.toHaveProperty("id");
	});

	it("creates an environment with POST /environments", async () => {
		await apiService.createEnvironment({ name: "Dev", variables: {} });
		expect(put).not.toHaveBeenCalled();
		expect(post).toHaveBeenCalledWith("/environments", { name: "Dev", variables: {} });
	});

	it("updates an environment with PUT /environments/:id, id in the path only", async () => {
		await apiService.updateEnvironment({ id: "env_1", name: "Prod" });
		expect(post).not.toHaveBeenCalled();
		expect(put).toHaveBeenCalledWith("/environments/env_1", { name: "Prod" });
		expect(put.mock.calls[0][1]).not.toHaveProperty("id");
	});

	// Every create strips `id`, whatever the caller passed. A payload builder
	// that spreads a whole record is the case the types cannot catch: the
	// `Create*Request` types declare `id?: never`, but that only fires on an
	// object literal, so the runtime strip is what actually holds. Each of these
	// would fail with the strip removed - the engine's 400 would surface as a
	// broken save instead.
	it("strips a client-supplied id from a collection create", async () => {
		await apiService.createCollection({ id: "col_temp", name: "Imported" } as never);
		expect(put).not.toHaveBeenCalled();
		expect(post).toHaveBeenCalledWith("/collections", { name: "Imported" });
		expect(post.mock.calls[0][1]).not.toHaveProperty("id");
	});

	it("strips a client-supplied id from a request create", async () => {
		await apiService.createRequest({
			id: "req_temp",
			collectionId: "col_1",
			name: "R",
			method: "GET",
			url: "https://example.com",
		} as never);
		expect(put).not.toHaveBeenCalled();
		expect(post.mock.calls[0][0]).toBe("/requests");
		expect(post.mock.calls[0][1]).not.toHaveProperty("id");
	});

	it("strips a client-supplied id from an environment create", async () => {
		await apiService.createEnvironment({
			id: "env_temp",
			name: "Dev",
			variables: {},
		} as never);
		expect(put).not.toHaveBeenCalled();
		expect(post).toHaveBeenCalledWith("/environments", { name: "Dev", variables: {} });
		expect(post.mock.calls[0][1]).not.toHaveProperty("id");
	});
});

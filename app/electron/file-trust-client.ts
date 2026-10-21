/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main process's writes to file trust (#2356): the four engine routes that
 * decide which files a request body may send - `POST`/`DELETE /file-grants` and
 * `POST`/`DELETE /file-roots` - and the reads of the grants and the allowed folders beside them.
 *
 * The engine refuses those writes without the grant secret the sidecar spawned
 * it with, and this module is the one holder of that secret and the one place
 * that sends it. Nothing here is reachable from the renderer: the IPC channels
 * that end up here take a path main minted (a picked file, a chosen folder) or
 * a row id, never a path the renderer names.
 *
 * Every call answers an {@link EngineWrite} and never throws, because each
 * caller is an IPC handler or a background record that has a reply to give
 * either way. Electron-free, so it is tested with a stub `fetch`.
 */

import { ENGINE_GRANT_SECRET_HEADER } from "./constants.js";
import { engineFetch } from "./engine-fetch.js";

/** A row of `file_roots` or `file_grants`, as the engine answers it. */
export interface FileTrustRow {
	id: string;
	path: string;
	createdAt: number;
}

/**
 * What became of one call. `refused` is the engine's own answer, its status,
 * code and message kept so a caller can tell a 409 (already there, which is
 * what the user wanted) from a 400; `unreachable` is no answer at all.
 */
export type EngineWrite<T> =
	| { outcome: "done"; value: T }
	| { outcome: "refused"; status: number; code: string; message: string }
	| { outcome: "unreachable"; message: string };

export interface FileTrustClientDeps {
	/** The engine's origin this session (`engineOrigin` in production). */
	origin: () => string;
	fetch?: typeof engineFetch;
}

export interface FileTrustClient {
	/** The secret of the engine just spawned. Replaces the last one. */
	setSecret(secret: string): void;
	createFileGrant(filePath: string): Promise<EngineWrite<FileTrustRow>>;
	listFileGrants(): Promise<EngineWrite<FileTrustRow[]>>;
	listFileRoots(): Promise<EngineWrite<FileTrustRow[]>>;
	createFileRoot(folder: string): Promise<EngineWrite<FileTrustRow>>;
	deleteFileRoot(id: string): Promise<EngineWrite<null>>;
}

/**
 * An id the engine minted (`froot_...`, `fgrant_...`). Checked before it is
 * spliced into a URL: an id holding `/` or `..` would aim the secret at another
 * route.
 */
const ROW_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isRowId(id: unknown): id is string {
	return typeof id === "string" && ROW_ID.test(id);
}

/** `{"error": {"code", "message"}}`, the one shape the engine refuses with since #173. */
async function readRefusal(response: Response): Promise<EngineWrite<never>> {
	const body = (await response.json().catch(() => null)) as {
		error?: { code?: unknown; message?: unknown };
	} | null;
	const code = typeof body?.error?.code === "string" ? body.error.code : "UNKNOWN_ERROR";
	const message =
		typeof body?.error?.message === "string" && body.error.message
			? body.error.message
			: `HTTP ${response.status}`;
	return { outcome: "refused", status: response.status, code, message };
}

export function createFileTrustClient(deps: FileTrustClientDeps): FileTrustClient {
	const send = deps.fetch ?? engineFetch;
	let secret: string | null = null;

	async function call<T>(
		route: string,
		init: { method: string; body?: unknown; gated: boolean },
		read: (response: Response) => Promise<T>
	): Promise<EngineWrite<T>> {
		if (init.gated && secret === null) {
			return { outcome: "unreachable", message: "The engine has not been started yet." };
		}
		const headers: Record<string, string> = {};
		if (init.gated && secret !== null) headers[ENGINE_GRANT_SECRET_HEADER] = secret;
		if (init.body !== undefined) headers["Content-Type"] = "application/json";
		try {
			const response = await send(`${deps.origin()}${route}`, {
				method: init.method,
				headers,
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			});
			if (!response.ok) return await readRefusal(response);
			return { outcome: "done", value: await read(response) };
		} catch (error) {
			return {
				outcome: "unreachable",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	const row = async (response: Response) => (await response.json()) as FileTrustRow;

	return {
		setSecret(next) {
			secret = next;
		},

		createFileGrant: (filePath) =>
			call("/file-grants", { method: "POST", body: { path: filePath }, gated: true }, row),

		listFileGrants: () =>
			call(
				"/file-grants",
				{ method: "GET", gated: false },
				async (response) => (await response.json()) as FileTrustRow[]
			),

		listFileRoots: () =>
			call(
				"/file-roots",
				{ method: "GET", gated: false },
				async (response) => (await response.json()) as FileTrustRow[]
			),

		createFileRoot: (folder) =>
			call("/file-roots", { method: "POST", body: { path: folder }, gated: true }, row),

		deleteFileRoot: async (id) => {
			if (!isRowId(id)) {
				return {
					outcome: "refused",
					status: 400,
					code: "invalid_id",
					message: "Not an allowed-folder id.",
				};
			}
			return call(`/file-roots/${id}`, { method: "DELETE", gated: true }, async () => null);
		},
	};
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file trash.ts
 * @brief Naming a trash entry for the purge prompt, and the engine's refusals
 *        in its own words (#988, #1071).
 */

import { type EngineClient, EngineRequestError } from "../engine-client.js";
import { engineSentence } from "./failure.js";
import { isRecord, ToolArgError } from "./kit.js";

const TRASH_KINDS = ["collection", "request", "environment", "example"] as const;

/** One `GET /trash` row, as `purge_trash_entry` needs it to name what it destroys. */
export interface TrashRow {
	kind: (typeof TRASH_KINDS)[number];
	name: string;
	/** Sub-collections this row's delete took with it. Always 0 for a request, an environment or an example. */
	collections: number;
	/** Requests this row's delete took with it. Always 0 for a request, an environment or an example. */
	requests: number;
	/** The environment's variable count; the engine sends it on environment rows only. */
	variables: number;
}

function isTrashKind(kind: unknown): kind is TrashRow["kind"] {
	return TRASH_KINDS.some((known) => known === kind);
}

/**
 * Read one trash entry by id off `GET /trash` - there is no single-entry route,
 * the same reason {@link EngineClient.getCollection} scans the collection list.
 *
 * Thrown rather than defaulted, on {@link readCascadeScope}'s reasoning: an
 * entry nobody could read must not become a purge prompt carrying a name and
 * counts nobody verified. A kind this build does not know is refused the same
 * way, rather than described as one it does (#2970).
 */
export async function readTrashEntry(
	client: EngineClient,
	id: string,
	signal?: AbortSignal
): Promise<TrashRow> {
	const payload = await client.listTrash(signal);
	const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
	const row = items.find((item) => isRecord(item) && item.id === id) as
		Record<string, unknown> | undefined;
	if (!row) throw new ToolArgError(`Nothing in the trash with id "${id}".`, "not_found");
	if (!isTrashKind(row.kind)) {
		throw new ToolArgError(
			`Trash entry "${id}" is of a kind this version of Vayu does not know (${JSON.stringify(row.kind)}), so nothing was done to it.`,
			"policy"
		);
	}
	return {
		kind: row.kind,
		name: typeof row.name === "string" && row.name !== "" ? row.name : id,
		collections: typeof row.collections === "number" ? row.collections : 0,
		requests: typeof row.requests === "number" ? row.requests : 0,
		variables: typeof row.variables === "number" ? row.variables : 0,
	};
}

/** One phrase naming what purging this entry destroys. */
export function describeTrashEntry(entry: TrashRow): string {
	switch (entry.kind) {
		case "environment":
			return (
				`the environment "${entry.name}", with ` +
				`${entry.variables} variable${entry.variables === 1 ? "" : "s"} in it`
			);
		case "request":
			return `the saved request "${entry.name}"`;
		case "example":
			return `the saved example "${entry.name}"`;
		case "collection": {
			const subject = `the collection "${entry.name}"`;
			if (entry.collections === 0 && entry.requests === 0) return subject;
			return (
				`${subject}, with ${entry.collections} sub-collection(s) and ` +
				`${entry.requests} saved request(s) inside it`
			);
		}
	}
}

/**
 * The engine's own refusal text off a 404/409 `EngineRequestError` from
 * `POST /trash/:id/restore`. Both of restore's failure shapes name the fix (a
 * wrong id, or which collection to restore first, per `trash.cpp`), so this
 * surfaces that sentence rather than writing a second one that could disagree
 * with it. Anything but an error body falls back to the body, then the status
 * line - reading a refusal must never throw.
 */
export function trashRefusalMessage(err: EngineRequestError): string {
	return engineSentence(err.body) ?? (err.body || err.message);
}

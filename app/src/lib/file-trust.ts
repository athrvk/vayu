/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The file-reference trust flag (`FileRef.unresolved`, `FormFieldEntry.unresolved`)
 * is the engine's answer for this machine, never the renderer's claim (#2356).
 *
 * The engine derives it on every read that hands a body to an editor: `true`
 * for a concrete path it would refuse (neither under an allowed folder nor
 * picked), `false` for an allowed or picked path or one still holding `{{`, no
 * key for an empty path. It ignores the key on every write and send, so no
 * payload carries it: the `without*` helpers strip it on the way out.
 *
 * The editor writes one value of its own, between engine reads: a pick sets
 * `false`, because the pick is what the main process records as a grant
 * (preload `getFilePath`). A typed or pasted path carries no key until the
 * engine answers for it, and reads as unresolved meanwhile, because the engine
 * refuses it unless it lies under an allowed folder.
 */

import type { FileRef, FormFieldEntry, RequestBody } from "@/types";

/** Whether the editor warns about a path: anything but an explicit `false`. */
export const isUnresolved = (flag: boolean | undefined): boolean => flag !== false;

/**
 * The flag a pick leaves on a reference. `undefined`, not an absent key, so a
 * spread over a reference the engine answered `true` for clears that answer;
 * a pick outside Electron yields no path and nothing the engine could grant.
 */
export const flagAfterPick = (src: string): false | undefined => (src ? false : undefined);

/** A binary body with no file in it. */
export const noFile = (): FileRef => ({ src: "" });

/** Every row without the trust flag, for a payload. */
export function withoutFileTrust<T extends FormFieldEntry>(fields: readonly T[]): T[] {
	return fields.map(({ unresolved: _unresolved, ...rest }) => rest as T);
}

/**
 * A body without any file reference's trust flag, for a payload that forwards
 * a body the engine handed out (an import draft, a Duplicate).
 */
export function withoutBodyFileTrust(body: RequestBody): RequestBody {
	if (body.mode === "binary") {
		const { unresolved: _unresolved, ...file } = body.file ?? noFile();
		return { ...body, file };
	}
	if (body.mode === "form-data") return { ...body, fields: withoutFileTrust(body.fields ?? []) };
	return body;
}

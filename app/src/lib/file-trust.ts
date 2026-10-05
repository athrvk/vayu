/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The file-body trust flag (`FileRef.unresolved`, `FormFieldEntry.unresolved`)
 * as every writer states it.
 *
 * The engine reads an absent flag as `true`, so a body that leaves it out is a
 * file the engine will not open outside an allowed folder. Every payload states
 * it: `false` only for a file the user chose in this app on this machine,
 * `true` for anything else. A row stored before writers sent the key reads the
 * way the engine reads it, and the editor normalises on load as well as on the
 * way out, so its warning and the engine's refusal agree.
 */

import type { FileRef, FormFieldEntry, RequestBody } from "@/types";

/** `unresolved` as sent: only an explicit `false` was chosen here. */
export const isUnresolved = (flag: boolean | undefined): boolean => flag !== false;

/** A binary body with no file in it. Nothing was chosen, so nothing is trusted. */
export const noFile = (): FileRef => ({ src: "", unresolved: true });

/** The fields with every file part's flag stated; text parts are untouched. */
export function withFileTrust<T extends FormFieldEntry>(fields: readonly T[]): T[] {
	return fields.map((field) =>
		field.type === "file" ? { ...field, unresolved: isUnresolved(field.unresolved) } : field
	);
}

/**
 * A stored or parsed body with its file references' flags stated. Applied where
 * a body enters the renderer from the engine (`RequestTransformer`, an import
 * draft), so whatever forwards it later - a Duplicate, a sync - forwards the
 * flag the engine would have read.
 */
export function withBodyFileTrust(body: RequestBody): RequestBody {
	if (body.mode === "binary") {
		const file = body.file ?? noFile();
		return { ...body, file: { ...file, unresolved: isUnresolved(file.unresolved) } };
	}
	if (body.mode === "form-data") return { ...body, fields: withFileTrust(body.fields ?? []) };
	return body;
}

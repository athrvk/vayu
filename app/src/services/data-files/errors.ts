/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one error type the data-file layer throws.
 *
 * It lives in its own module rather than in `index.ts` so the tokenizer can
 * throw it too: `tabular.ts` is imported *by* `index.ts`, and importing the
 * class back the other way would be a cycle.
 */

/**
 * A file that cannot become rows. The message names the row, line or column at
 * fault, because "could not parse" sends the user back to a file they have no
 * reason to suspect a particular part of.
 */
export class DataFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DataFileError";
	}
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the environment row's "Export as Postman environment" tells the user
 * about the engine's answer (#2253): what the saved document left out.
 */

import { pluralize } from "@/modules/dashboard/utils/format";
import type { PostmanEnvironmentExportNotes } from "@/types";

/**
 * The `notCarried` code for a type Postman's one `type` slot cannot hold: a
 * `json` type, written as `default`, and a typed secret's type, written as
 * `secret` (#3252).
 */
const VARIABLE_TYPES_NOT_CARRIED = "variable_types";

/**
 * The success toast: the file's name, then each loss that has a count. A
 * silent export would let a blank secret pass for a copied one.
 */
export function postmanEnvironmentExportMessage(
	fileName: string,
	notes: PostmanEnvironmentExportNotes
): string {
	const typesLost = notes.notCarried
		.filter((entry) => entry.code === VARIABLE_TYPES_NOT_CARRIED)
		.reduce((total, entry) => total + entry.count, 0);

	const losses: string[] = [];
	if (notes.secretsOmitted > 0) {
		const noun = pluralize(notes.secretsOmitted, "secret value");
		losses.push(`${notes.secretsOmitted} ${noun} left blank`);
	}
	if (typesLost > 0) {
		const noun = pluralize(typesLost, "variable type");
		losses.push(`${typesLost} ${noun} left out`);
	}
	return losses.length === 0
		? `Exported ${fileName}`
		: `Exported ${fileName} - ${losses.join(", ")}`;
}

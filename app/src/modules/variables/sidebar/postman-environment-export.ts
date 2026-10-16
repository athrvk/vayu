/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the environment row's "Export as Postman Environment" does with the
 * engine's answer (#2253): save the document and say what it left out.
 */

import { pluralize } from "@/modules/dashboard/utils/format";
import type { PostmanEnvironmentExportNotes } from "@/types";

/** The `notCarried` code for `json`-typed variables, which Postman has no type for. */
const JSON_TYPES_NOT_CARRIED = "variable_types";

/** Hand `text` to the browser as a file called `fileName`. */
export function downloadJsonFile(fileName: string, text: string): void {
	const blob = new Blob([text], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	URL.revokeObjectURL(url);
}

/**
 * The success toast: the file's name, then each loss that has a count. A
 * silent export would let a blank secret pass for a copied one.
 */
export function postmanEnvironmentExportMessage(
	fileName: string,
	notes: PostmanEnvironmentExportNotes
): string {
	const jsonWrittenAsDefault = notes.notCarried
		.filter((entry) => entry.code === JSON_TYPES_NOT_CARRIED)
		.reduce((total, entry) => total + entry.count, 0);

	const losses: string[] = [];
	if (notes.secretsOmitted > 0) {
		const noun = pluralize(notes.secretsOmitted, "secret value");
		losses.push(`${notes.secretsOmitted} ${noun} left blank`);
	}
	if (jsonWrittenAsDefault > 0) {
		const noun = pluralize(jsonWrittenAsDefault, "JSON variable");
		losses.push(`${jsonWrittenAsDefault} ${noun} written as default`);
	}
	return losses.length === 0
		? `Exported ${fileName}`
		: `Exported ${fileName} - ${losses.join(", ")}`;
}

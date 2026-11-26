/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The sentences `DeleteConfirmDialog` builds (#1689), apart from the dialog so its file exports
 * only a component (`react-refresh/only-export-components`).
 */

import { pluralize } from "@/modules/dashboard/utils/format";

/**
 * The sentence `DeleteConfirmDialog` builds from `name`, exported so a caller needing the words
 * elsewhere (a toast confirming the delete) quotes the dialog's noun rather than a drifting second
 * phrasing. One sentence shape, reworded away from the three call-site phrasings it replaced;
 * `delete-confirm-dialog.test.tsx` holds the generated sentence clear of them.
 */
export function deleteConfirmCopy(name: string): { title: string; description: string } {
	const subject = `"${name}"`;
	return {
		title: `Delete ${subject}?`,
		description: `${subject} is removed permanently. This can't be undone.`,
	};
}

/**
 * An environment delete's description beyond the template (docs/ux-writing.md's calibration example
 * for this flow): how many variables go, that requests using them send the literal `{{token}}` text
 * rather than failing, and that the Trash can restore it, as the delete is soft (#2970) and
 * "removed permanently" would be false. Both call sites (the header's dialog, the sidebar row menu)
 * build from this, so their copy cannot drift.
 */
export function environmentDeleteDescription(environment: {
	variables: Record<string, unknown>;
}): string {
	const count = Object.keys(environment.variables).length;
	return (
		`Its ${count} ${pluralize(count, "variable")} ${pluralize(count, "goes", "go")} with it. ` +
		"Requests that use them will send the literal `{{variableName}}` text. " +
		"You can restore it from Trash."
	);
}

/**
 * A saved example delete's description beyond the template: what a mock server does with the row,
 * and what brings it back, which differ by origin as the engine's handling does (#2971, #722). A
 * saved (`user`) example goes to the Trash; an imported one becomes a spec-sync tombstone, so a
 * sync does not write it back and re-importing the document is the one way it returns.
 */
export function exampleDeleteDescription(origin: "import" | "user"): string {
	const mockServer =
		"The example is removed from this request. A mock server for this collection " +
		"stops answering with it once it is restarted. ";
	return (
		mockServer +
		(origin === "import"
			? "Syncing this collection with its spec won't bring it back; re-importing the document will."
			: "You can restore it from Trash.")
	);
}

/**
 * A client certificate removal's description beyond the template: what its host does without it,
 * that the files stay where they are, and that the Trash can restore it (soft delete, #2973).
 * `target` is the registry's `host` or `host:port`.
 */
export function clientCertificateDeleteDescription(target: string): string {
	return (
		`Requests to ${target} will be sent without a client certificate. ` +
		"The certificate and key files themselves are not touched. " +
		"You can restore it from Trash."
	);
}

/**
 * The Trash's purge description for a client certificate, saying what "removed permanently" cannot:
 * the stored key passphrase goes with the row (kept nowhere else), and the files it pointed at are
 * untouched.
 */
export function clientCertificatePurgeDescription(target: string): string {
	return (
		`"${target}" is removed permanently, along with its stored passphrase. ` +
		"The certificate and key files on disk are not touched."
	);
}

/**
 * The Trash's purge description for a collection: the engine's purge totals (#3449), counting every
 * deleted row under it whichever delete stamped it, so it says what "Delete forever" removes, not
 * what a restore brings back. An empty collection reads as the generic sentence.
 */
export function collectionPurgeDescription(
	name: string,
	purged: { collections: number; requests: number }
): string {
	const parts: string[] = [];
	if (purged.collections > 0) {
		parts.push(`${purged.collections} ${pluralize(purged.collections, "collection")}`);
	}
	if (purged.requests > 0) {
		parts.push(`${purged.requests} ${pluralize(purged.requests, "request")}`);
	}
	if (parts.length === 0) return deleteConfirmCopy(name).description;
	return `"${name}" is removed permanently, along with ${parts.join(" and ")} inside it. This can't be undone.`;
}

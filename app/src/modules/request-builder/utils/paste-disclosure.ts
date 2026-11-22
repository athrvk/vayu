/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The curl-paste disclosure ledger, as notices (issue #708).
 *
 * Three rules the shape enforces:
 *
 * - **It never blocks the paste.** The import already happened; this only says
 *   what it could not carry or had to rename.
 * - **A toast per subject, each one sentence.** Dismissible, not a panel that
 *   has to be cleared (`docs/ux-writing.md` budgets a toast at one sentence).
 * - **A pointer only where a home exists.** A flag whose intent Vayu has no
 *   answer for is still named, without an action that would go nowhere.
 */

import type { ToastOptions } from "@/stores/toast-store";
import type { CommandFailure, CommandImport, DroppedFlag } from "@/services/curl/parseCurl";
import { revealSetting } from "@/modules/settings/reveal";

const UNREADABLE_COMMAND_REASON: Record<CommandFailure, string> = {
	"not-a-command": "The text is not a cURL or wget command",
	"unterminated-quote": "You opened a quote and never closed it",
	"missing-url": "The command has no URL",
	unreadable: "Vayu couldn't parse the command",
};

/**
 * The notice for a pasted command that could not be imported (#3685). The paste
 * is taken over before the import runs, so without it an unreadable command
 * vanishes; the reason is named because each is fixed in a different place.
 */
export function unreadableCommandNotice(reason: CommandFailure): ToastOptions {
	return {
		title: "Couldn't import the command",
		message: `${UNREADABLE_COMMAND_REASON[reason]}, so the request was left as it was.`,
		variant: "warning",
	};
}

/** `-x routed the request through a proxy (Proxy settings)`. */
function describe(dropped: DroppedFlag): string {
	const home = dropped.pointer ? ` (${dropped.pointer.label})` : "";
	return `${dropped.flag} ${dropped.what}${home}`;
}

/**
 * The notice for what a paste dropped, or null when it dropped nothing.
 *
 * Null rather than an empty toast: the common paste carries everything, and a
 * "nothing was lost" notice on every one of them is how a disclosure surface
 * gets learned as noise and stops being read.
 *
 * `warning` rather than `info`, because a request that will now go direct when
 * the command said "through this proxy" fails later for a reason the paste is
 * responsible for - and the severity floor a user can raise must not hide that.
 */
export function droppedFlagsNotice(dropped: DroppedFlag[]): ToastOptions | null {
	if (dropped.length === 0) return null;

	// The first pointer, not one per flag: a toast has room for one action, and
	// the flags that carry a pointer nearly always share a destination (three of
	// the four homes are the same settings category).
	const destination = dropped.find((entry) => entry.pointer)?.pointer;

	return {
		title: "Imported, minus some flags",
		message: `${dropped.map(describe).join("; ")}.`,
		variant: "warning",
		...(destination
			? {
					action: {
						label: "Open settings",
						altText: `Open ${destination.label}`,
						onClick: () => revealSetting(destination.category, destination.anchor),
					},
				}
			: {}),
	};
}

/**
 * The notice for the shell variables a paste turned into `{{NAME}}` (#3777), or
 * null when it named none. `info`: the request is correct and sends the literal
 * text only until each name has a value.
 */
function variablesNotice(variables: string[]): ToastOptions | null {
	if (variables.length === 0) return null;

	const names = variables.map((name) => `{{${name}}}`).join(", ");
	return {
		title: "Imported with variables",
		message: `Shell variables became ${names} - give them values in an environment.`,
		variant: "info",
	};
}

/**
 * What a pasted command earns the user: a toast for the variables it named and
 * one for the flags it dropped, in that order, each a single sentence. Empty
 * when the paste changed nothing the user needs to hear about.
 */
export function pasteNotices(
	imported: Pick<CommandImport, "dropped" | "variables">
): ToastOptions[] {
	return [variablesNotice(imported.variables), droppedFlagsNotice(imported.dropped)].filter(
		(notice): notice is ToastOptions => notice !== null
	);
}

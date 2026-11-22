/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The curl-paste disclosure ledger, as a notice (issue #708).
 *
 * Pasting a command has always imported what it could and said nothing about
 * the rest, so `-x`, `--cert` and `--cacert` were silently eaten and the paste
 * looked complete. The structured importers gained this discipline in #666;
 * this is the one import path that never had it.
 *
 * Three rules the shape enforces:
 *
 * - **It never blocks the paste.** The import already happened and is correct
 *   as far as it goes; this only says what it could not carry.
 * - **One notice, dismissible.** A toast, not a panel that has to be cleared -
 *   the information is worth a glance and nothing more.
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
 * The notice for a pasted command that could not be imported (#3685).
 *
 * The paste is taken over before the import runs, so without this a command the
 * parser cannot read vanishes: nothing lands in the field and nothing says why.
 * It names the reason, because "unterminated quote" and "no URL" are fixed in
 * different places in the command.
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
 * What a paste did to the shell variables it wrote (#3777): they were turned
 * into `{{NAME}}`, and the request will send the literal text until each one
 * has a value. A single sentence, because it shares a toast with the dropped
 * flags.
 */
function variablesMessage(variables: string[]): string {
	const names = variables.map((name) => `{{${name}}}`).join(", ");
	return `Shell variables became ${names} - give them values in an environment.`;
}

/**
 * The one notice a pasted command earns: what it dropped, what became a
 * variable, or both in a single toast. Null when the paste changed nothing the
 * user needs to hear about.
 *
 * One toast rather than two: a paste is one event. It is a `warning` whenever
 * flags were dropped (see `droppedFlagsNotice`) and an `info` when only
 * variables were named, which the request still sends correctly once they have
 * values.
 */
export function pasteNotice(
	imported: Pick<CommandImport, "dropped" | "variables">
): ToastOptions | null {
	const dropped = droppedFlagsNotice(imported.dropped);
	if (imported.variables.length === 0) return dropped;

	const message = variablesMessage(imported.variables);
	if (!dropped) return { title: "Imported with variables", message, variant: "info" };

	return {
		...dropped,
		title: "Imported with variables, minus some flags",
		message: `${message} ${dropped.message}`,
	};
}

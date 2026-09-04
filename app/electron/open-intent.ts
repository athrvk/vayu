/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the OS is asking Vayu to open (issue #1364).
 *
 * Two of the icon integrations hand the app something rather than showing it
 * something, and both arrive the same way - as a launch, with the request on the
 * command line or on an Electron event:
 *
 * - **A file dropped on the Dock or taskbar icon.** macOS raises `open-file`;
 *   Windows and Linux put the path in `process.argv` on a cold start, and in
 *   `second-instance`'s argv when Vayu is already up.
 * - **A Jump List task.** Windows tasks are shortcuts to the executable, so the
 *   collection travels as {@link OPEN_COLLECTION_ARG} on the same command line,
 *   through the same two doors.
 *
 * One reader for all of it, because the doors differ and the request does not,
 * and because a second argv parser is the one that would miss the next fix.
 *
 * **Everything is buffered until the renderer can act on it.** A cold launch
 * raises `open-file` before `whenReady` resolves - that is the whole point of
 * the event - and there is no window to send to, let alone a mounted store. So
 * intents queue, and {@link OpenIntents.ready} flushes them when the renderer
 * says it has loaded.
 *
 * This side does not read the file. It decides the path is worth offering - the
 * extension allowlist is `spec-file.ts`'s own, imported rather than restated -
 * and the renderer reads it through the gated `specFile:read` channel that
 * already exists, so nothing here becomes a second door onto the file system.
 */

import path from "path";

import { SPEC_FILE_EXTENSIONS } from "./spec-file.js";
import { OPEN_COLLECTION_ARG } from "./os-icon.js";

/** What main tells the renderer to open. */
export const OPEN_INTENT_CHANNEL = "intent:open";

/** One thing the OS asked for. */
export type OpenIntent =
	/** A document to import, by absolute path. */
	| { kind: "import"; path: string }
	/** A collection to open, by id, from the Jump List. */
	| { kind: "collection"; collectionId: string };

/**
 * Whether `candidate` is a document the import pipeline could read.
 *
 * The allowlist is the one `readSpecFile` enforces when the renderer comes back
 * for the bytes, so a path that passes here cannot be refused there for its
 * name - and a path that fails here never becomes an event the renderer has to
 * have an error state for.
 */
export function isImportableFile(candidate: string): boolean {
	if (!candidate || candidate.startsWith("-")) return false;
	return SPEC_FILE_EXTENSIONS.includes(path.extname(candidate).toLowerCase());
}

/**
 * Every intent on one command line, in the order it appears.
 *
 * `argv[0]` is skipped because it is the executable, never a request. A launch
 * ordinarily carries one intent; the loop is here because nothing stops a user
 * selecting two files and pressing Open, and dropping the second silently would
 * be the app deciding which of them the user meant.
 */
export function parseOpenIntents(argv: readonly string[]): OpenIntent[] {
	const intents: OpenIntent[] = [];
	for (const argument of argv.slice(1)) {
		if (argument.startsWith(OPEN_COLLECTION_ARG)) {
			const collectionId = argument.slice(OPEN_COLLECTION_ARG.length);
			if (collectionId) intents.push({ kind: "collection", collectionId });
			continue;
		}
		if (isImportableFile(argument)) intents.push({ kind: "import", path: argument });
	}
	return intents;
}

export interface OpenIntentDeps {
	/** Push one intent at the renderer. Returns false when there is nobody to push to. */
	send: (intent: OpenIntent) => boolean;
	/** Bring the window forward, because a launch that opens nothing looks broken. */
	focus: () => void;
}

export interface OpenIntents {
	/** Take one intent, delivering it now or when the renderer is ready. */
	offer(intent: OpenIntent): void;
	/** Take every intent on a command line. */
	offerArgv(argv: readonly string[]): void;
	/** The renderer has loaded; deliver what has been waiting. */
	ready(): void;
}

export function createOpenIntents(deps: OpenIntentDeps): OpenIntents {
	const pending: OpenIntent[] = [];
	/** Whether the renderer has said it can act on one. See the header. */
	let loaded = false;

	function deliver(intent: OpenIntent): void {
		if (deps.send(intent)) return;
		// A send that found no window is a renderer that is not there after all -
		// on macOS the app outlives its window, and `activate` builds a new one.
		// Queue the intent and wait to be told again, rather than dropping the
		// file the user just double-clicked.
		loaded = false;
		pending.push(intent);
	}

	function offer(intent: OpenIntent): void {
		deps.focus();
		if (loaded) deliver(intent);
		else pending.push(intent);
	}

	return {
		offer,

		offerArgv(argv: readonly string[]): void {
			for (const intent of parseOpenIntents(argv)) offer(intent);
		},

		ready(): void {
			loaded = true;
			const waiting = pending.splice(0, pending.length);
			for (const intent of waiting) deliver(intent);
		},
	};
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What each stage of an import is called on screen (issue #882).
 *
 * One map rather than a `switch` at the render site, because these words are
 * the *same* words in two places - the panel that replaces the dropzone while a
 * batch runs, and the bar in the footer while the apply runs - and a stage named
 * two ways is a stage a user cannot follow between them.
 *
 * Named for what is happening to the user's documents, not for the code path:
 * "Resolving references" is a `$ref` walk, and calling it "bundling" would name
 * an implementation nobody outside this repo has heard of.
 */
export const IMPORT_STAGE_LABELS = {
	reading: "Reading files",
	fetching: "Downloading",
	bundling: "Resolving references",
	parsing: "Reading documents",
	applying: "Importing",
} as const;

/**
 * The events a streamed `POST /import/fetch` sends, mirroring
 * `constants::import_fetch::EVENT_*` engine-side (issue #882).
 *
 * Named here rather than compared as bare strings for the reason every wire
 * contract in this directory is: an unknown SSE event is an event the reader
 * *skips*, so a name that drifted would not throw - the download would simply
 * report into a branch nothing takes, and the bar would sit at zero while the
 * bytes arrived.
 */
export const IMPORT_FETCH_EVENTS = {
	PROGRESS: "progress",
	RESULT: "result",
	ERROR: "error",
} as const;

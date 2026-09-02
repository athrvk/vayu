/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every body a request can carry, in the order the picker offers them.
 *
 * `contentType` is what the panel *shows* beside the picker - what will go on
 * the wire for that mode, whether the panel writes the header or the engine
 * implies it. Which Content-Type a mode makes the panel actually write a header
 * row for is the separate, narrower rule in `content-type.ts`; the two answer
 * different questions and a mode can have one without the other (`json` shows
 * `application/json` and writes nothing).
 *
 * It sits in its own module rather than in `BodyPanel.tsx` because
 * `body-editor-completion.test.tsx` derives the modes it renders from this
 * table: a list of modes written out again in the test is the same silent drift
 * as the hand-written list of languages the guard exists to catch - `xml` was
 * absent from both for as long as the mode existed (#1214). A component file
 * cannot export it (react-refresh), and the table is data about bodies, not
 * about the panel that renders them.
 */

import type { BodyMode } from "../../../../types";

export interface BodyModeOption {
	value: BodyMode;
	label: string;
	/** What goes on the wire in this mode, or null when nothing is sent. */
	contentType: string | null;
}

export const BODY_MODES: BodyModeOption[] = [
	{ value: "none", label: "None", contentType: null },
	{ value: "json", label: "JSON", contentType: "application/json" },
	{ value: "text", label: "Text", contentType: "text/plain" },
	{ value: "graphql", label: "GraphQL", contentType: "application/json" },
	{ value: "jsonrpc", label: "JSON-RPC", contentType: "application/json" },
	{ value: "xml", label: "XML", contentType: "application/xml" },
	{ value: "form-data", label: "Form Data", contentType: "multipart/form-data" },
	{
		value: "x-www-form-urlencoded",
		label: "URL Encoded",
		contentType: "application/x-www-form-urlencoded",
	},
];

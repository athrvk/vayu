/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every body a request can carry, in picker order. `contentType` is what the panel *shows* beside
 * the picker, what goes on the wire whether the panel writes it or the engine implies it; which
 * modes make the panel write a header row is `content-type.ts`'s narrower rule (`text` shows
 * `text/plain` and writes nothing, since the engine derives it at send). Its own module because
 * `body-editor-completion.test.tsx` derives the modes it renders from this table, so no second list
 * can drift and leave a mode untested (#1214, `xml`); a component file cannot export it
 * (react-refresh), and it is data about bodies, not the panel.
 */

import type { BodyMode } from "../../../../types";

export interface BodyModeOption {
	value: BodyMode;
	label: string;
	/**
	 * What goes on the wire in this mode, or null when no one type applies: nothing is sent
	 * (`none`), or it depends on the file (`binary`, answered per request by
	 * `binary-content-type.ts`).
	 */
	contentType: string | null;
}

export const BODY_MODES: BodyModeOption[] = [
	{ value: "none", label: "None", contentType: null },
	{ value: "json", label: "JSON", contentType: "application/json" },
	{ value: "text", label: "Text", contentType: "text/plain" },
	{ value: "graphql", label: "GraphQL", contentType: "application/json" },
	{ value: "jsonrpc", label: "JSON-RPC", contentType: "application/json" },
	{ value: "mcp", label: "MCP", contentType: "application/json" },
	{ value: "xml", label: "XML", contentType: "application/xml" },
	{ value: "form-data", label: "Form data", contentType: "multipart/form-data" },
	{
		value: "x-www-form-urlencoded",
		label: "URL-encoded",
		contentType: "application/x-www-form-urlencoded",
	},
	{ value: "binary", label: "Binary file", contentType: null },
];

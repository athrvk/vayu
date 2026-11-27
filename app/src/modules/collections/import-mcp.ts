/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the Import dialog's MCP server tab holds and sends (#3843): the form's state, when it can be
 * sent, and the `POST /import/mcp` body it makes. Beside `ImportMcpForm.tsx`, which draws it; a
 * component file exports components only.
 */

import { withTrailingBlank } from "@/components/shared/KeyValueEditor/key-value";
import type { ImportMcpRequest, KeyValueItem } from "@/types";

export type McpPrimitive = "tools" | "resources" | "prompts";

export interface McpFormState {
	url: string;
	headers: KeyValueItem[];
	token: string;
	include: Record<McpPrimitive, boolean>;
}

/** A function, not a constant: the headers table's blank row carries an id of its own. */
export function emptyMcpForm(): McpFormState {
	return {
		url: "",
		headers: withTrailingBlank([]),
		token: "",
		include: { tools: true, resources: false, prompts: false },
	};
}

/** The engine refuses an `include` that leaves nothing in, so the form does not offer to send one. */
export function canConnectMcp(form: McpFormState): boolean {
	return form.url.trim() !== "" && Object.values(form.include).some(Boolean);
}

/**
 * What `POST /import/mcp` is sent. A blank or disabled header row is the table's spare or one the
 * user switched off, so it goes nowhere; a named row with no value is sent as it stands. The
 * engine refuses a header with no name at send and one carrying CR, LF or NUL, not an empty value.
 */
export function mcpImportRequest(form: McpFormState): ImportMcpRequest {
	const headers = form.headers
		.filter((row) => row.enabled && (row.key.trim() !== "" || row.value !== ""))
		.map((row) => ({ name: row.key.trim(), value: row.value }));
	const token = form.token.trim();
	return {
		url: form.url.trim(),
		...(headers.length > 0 ? { headers } : {}),
		...(token !== "" ? { auth: { mode: "bearer" as const, token } } : {}),
		include: form.include,
	};
}

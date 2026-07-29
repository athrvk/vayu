/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A GraphQL request body is one JSON object with a `query` and optional
 * `variables`, but the editor shows it as two panes. These convert between the
 * two.
 *
 * Both halves tolerate input the other would reject, deliberately:
 *
 * - `parseGraphQLBody` falls back to treating the whole body as a raw query
 *   string, because an Insomnia import produces exactly that.
 * - `serializeGraphQLBody` drops the variables when they are mid-edit and not
 *   yet valid JSON, rather than refusing to write - which would mean the query
 *   pane stopped saving while the variables pane had an unclosed brace.
 */

export function parseGraphQLBody(body: string): { query: string; variables: string } {
	try {
		const parsed = JSON.parse(body);
		if (parsed && typeof parsed.query === "string") {
			return {
				query: parsed.query,
				variables: parsed.variables ? JSON.stringify(parsed.variables, null, 2) : "",
			};
		}
	} catch {
		// Body is not JSON - treat as a raw query string (e.g. Insomnia import)
	}
	// Raw query string - show as-is, no variables
	return { query: body, variables: "" };
}

export function serializeGraphQLBody(query: string, variables: string): string {
	try {
		const vars = variables.trim() ? JSON.parse(variables) : undefined;
		return JSON.stringify({ query, ...(vars !== undefined && { variables: vars }) });
	} catch {
		// Variables panel has in-progress invalid JSON - preserve query only
		return JSON.stringify({ query });
	}
}

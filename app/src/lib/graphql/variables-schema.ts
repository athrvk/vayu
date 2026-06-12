/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Derives a JSON Schema for a GraphQL operation's variables (from the query's
 * `$variable` definitions + the schema) and applies it to the variables JSON
 * editor, so it validates/autocompletes against what the query actually expects.
 */

import type * as Monaco from "monaco-editor";
import type { GraphQLSchema } from "graphql";
import {
	getOperationFacts,
	getVariablesJSONSchema,
	type JSONSchema6,
} from "graphql-language-service";

const VARIABLES_SCHEMA_URI = "inmemory://graphql-variables-schema.json";

/**
 * Pure: build a JSON Schema for the query's variables, or null when there is no
 * schema, no declared variables, or the query can't be parsed.
 */
export function buildVariablesJsonSchema(
	query: string,
	schema: GraphQLSchema | null
): JSONSchema6 | null {
	if (!schema || !query.trim()) return null;
	try {
		const facts = getOperationFacts(schema, query);
		if (facts?.variableToType && Object.keys(facts.variableToType).length > 0) {
			return getVariablesJSONSchema(facts.variableToType);
		}
	} catch {
		// Unparseable / invalid query — no variables schema to offer.
	}
	return null;
}

/**
 * Register (or clear) the variables JSON Schema on Monaco's JSON language,
 * scoped to the given variables model URI via fileMatch so other JSON editors
 * are unaffected. Existing schemas from other sources are preserved.
 */
export function applyVariablesSchema(
	monaco: typeof Monaco,
	variablesModelUri: string,
	query: string,
	schema: GraphQLSchema | null
): void {
	const jsonSchema = buildVariablesJsonSchema(query, schema);
	// monaco 0.55 relocated the JSON language namespace to the top level
	// (monaco.languages.json is type-deprecated).
	const defaults = monaco.json.jsonDefaults;
	const others = (defaults.diagnosticsOptions.schemas ?? []).filter(
		(s) => s.uri !== VARIABLES_SCHEMA_URI
	);
	defaults.setDiagnosticsOptions({
		...defaults.diagnosticsOptions,
		validate: true,
		schemas: jsonSchema
			? [
					...others,
					{
						uri: VARIABLES_SCHEMA_URI,
						fileMatch: [variablesModelUri],
						schema: jsonSchema,
					},
				]
			: others,
	});
}

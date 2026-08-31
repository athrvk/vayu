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

import type { MonacoApi } from "../monaco-api";
import type { GraphQLSchema } from "graphql";
import {
	getOperationFacts,
	getVariablesJSONSchema,
	type JSONSchema6,
} from "graphql-language-service";
import { maskGraphqlTemplates } from "./templates";
import { templateTwinUri } from "./variables-diagnostics";

const VARIABLES_SCHEMA_URI = "inmemory://graphql-variables-schema.json";

/**
 * Pure: build a JSON Schema for the query's variables, or null when there is no
 * schema, no declared variables, or the query can't be parsed.
 *
 * The query is masked first, because `getOperationFacts` *parses* it and an
 * unmasked `{{token}}` is a parse failure: a query that mentions one token
 * anywhere lost the schema for every variable it declares, so the pane fell back
 * to no validation and no completion at all. Only the variable-to-type map is
 * read here, so nothing downstream cares where the tokens were - the mask is
 * length-preserving anyway, being the same one the query pane's diagnostics use.
 */
export function buildVariablesJsonSchema(
	query: string,
	schema: GraphQLSchema | null
): JSONSchema6 | null {
	if (!schema || !query.trim()) return null;
	try {
		const facts = getOperationFacts(schema, maskGraphqlTemplates(query).masked);
		if (facts?.variableToType && Object.keys(facts.variableToType).length > 0) {
			return getVariablesJSONSchema(facts.variableToType);
		}
	} catch {
		// Unparseable / invalid query - no variables schema to offer.
	}
	return null;
}

/**
 * Register (or clear) the variables JSON Schema on Monaco's JSON language,
 * scoped to the given variables model URI via fileMatch so other JSON editors
 * are unaffected. Existing schemas from other sources are preserved.
 *
 * The pane's masked twin (`variables-diagnostics.ts`) is matched too: it is the
 * model the worker's markers actually come from, so a schema registered only
 * against the visible one would validate nothing the user ever sees.
 */
export function applyVariablesSchema(
	monaco: MonacoApi,
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
						fileMatch: [variablesModelUri, templateTwinUri(variablesModelUri)],
						schema: jsonSchema,
					},
				]
			: others,
	});
}

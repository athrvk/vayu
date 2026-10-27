/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file variables.tools.ts
 * @brief Globals and variable resolution: `get_globals`, `resolve_variables` and
 *        `update_globals`.
 */

import { z } from "zod";
import {
	ENVIRONMENT_DEFAULT_SENTENCE,
	type OriginScopes,
	precedenceNote,
	resolveVariableReports,
} from "../variable-origins.js";
import { secretsShape, withheldPointer, withholdRowSecrets } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngineStructured,
	echoShape,
	engineErrorResult,
	errorResult,
	isRecord,
	mergeAndWrite,
	str,
	stringArray,
	structuredResult,
	ToolArgError,
	withCaveat,
	writesDisabled,
} from "./kit.js";
import {
	absentRemovalCaveat,
	describeScopes,
	gatherVariableScopes,
	mergeVariables,
	removalNames,
	removeVariablesInput,
	variablesInput,
} from "./variable-blobs.js";
import { globalsSchema, resolveVariablesSchema } from "./output-schemas.js";
import { GUARDED_WRITE_SENTENCE } from "../remedy.js";

export const VARIABLE_TOOLS: McpTool[] = [
	{
		name: "get_globals",
		category: "read",
		invalidates: [],
		description: (config) =>
			"Read the global variables - used by every request whatever environment is active. An engine that has never had any answers an empty set rather than an error. " +
			precedenceNote(
				"Globals are the bottom tier, so a value read back here is not necessarily the one a request resolves: use resolve_variables to see which definition actually wins."
			) +
			withheldPointer(config),
		annotations: {
			title: "Get global variables",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		outputSchema: globalsSchema,
		handler: (_args, ctx, signal) =>
			callEngineStructured(
				ctx,
				() => ctx.client.getGlobals(signal),
				secretsShape(ctx, withholdRowSecrets)
			),
	},
	{
		name: "resolve_variables",
		category: "read",
		invalidates: [],
		description: (config) =>
			'Answer which definition of a variable name actually wins in a given context, and list the ones it beat - the question get_globals and list_environments cannot, because each shows one tier in isolation. For every name it reports the winning value with the scope and source that supplied it, then every shadowed definition highest-precedence-first, each saying whether it was outranked by a higher tier or simply switched off (`enabled: false`). A switched-off row is the more common answer to "why is this not the value I set?", and a name whose every definition is disabled resolves to nothing at all rather than to an empty string. ' +
			precedenceNote(
				`${ENVIRONMENT_DEFAULT_SENTENCE} Pass a collectionId to include its chain.`
			) +
			" Reports what is stored: it resolves nothing on the wire and starts no run." +
			withheldPointer(config),
		annotations: {
			title: "Resolve variables",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.optional()
				.describe(
					"Optional collection ID. Includes that collection's chain, merged root-first, between globals and the environment."
				),
			environmentId: z
				.string()
				.optional()
				.describe(
					'Optional environment ID to resolve against, or "none" for no environment.'
				),
			names: z
				.array(z.string())
				.optional()
				.describe(
					"Optional variable names to report. Omit for every name defined anywhere in the context. A name nothing defines is reported as unresolved rather than omitted."
				),
		},
		outputSchema: resolveVariablesSchema,
		handler: async (args, ctx, signal) => {
			const collectionId = str(args, "collectionId");
			const environmentId = str(args, "environmentId");
			const names = stringArray(args, "names");

			let scopes: OriginScopes;
			let context: Record<string, unknown>;
			try {
				scopes = await gatherVariableScopes(ctx, collectionId, environmentId, signal);
				context = describeScopes(scopes, collectionId, environmentId);
			} catch (err) {
				// A bad id is the caller's mistake and must not be reported as an
				// engine failure - the same split `pagedRead`'s callers keep.
				if (err instanceof ToolArgError) return errorResult(err.message, err.failureClass);
				return engineErrorResult(err, ctx);
			}

			const variables = resolveVariableReports(
				scopes,
				names,
				ctx.config.revealSecretsToAgents
			);
			return structuredResult({
				context,
				variables,
				summary: {
					reported: variables.length,
					resolved: variables.filter((v) => v.resolved).length,
					shadowed: variables.filter((v) => v.shadowedBy.length > 0).length,
				},
			});
		},
	},
	{
		name: "update_globals",
		category: "write",
		retry: "safe",
		invalidates: ["environment"],
		description: (config) =>
			"Set, re-flag or remove global variables - the ones every request can resolve, whatever environment is active. Merges exactly as update_environment does: globals you do not name are left alone, and a named one keeps every flag you do not state. " +
			GUARDED_WRITE_SENTENCE +
			". " +
			precedenceNote(
				"Globals are the bottom tier: any collection or active-environment definition of the same name shadows what you write here, so a request whose value does not change after this call is usually shadowed rather than unwritten - resolve_variables names the definition that won."
			) +
			withheldPointer(config),
		annotations: {
			title: "Update global variables",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			variables: variablesInput("the globals"),
			removeVariables: removeVariablesInput("the globals"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const patch = isRecord(args.variables) ? args.variables : undefined;
			if (args.variables !== undefined && patch === undefined) {
				return errorResult(
					'"variables" must be an object mapping names to values.',
					"input"
				);
			}
			const removals = removalNames(args);
			if (patch === undefined && removals.length === 0) {
				return errorResult(
					'Pass at least one change: "variables" or "removeVariables".',
					"input"
				);
			}
			// `POST /globals` saves the singleton whole - it is the one resource
			// with no create/update split, so an absent `variables` there means
			// `{}`, not "keep". The read is what makes this a merge rather than a
			// replace, and the save is conditioned on the version it read.
			let absentRemovals: string[] = [];
			const result = await mergeAndWrite(ctx, {
				subject: "the set of globals",
				read: () => ctx.client.getGlobals(signal),
				merge: (stored) => {
					const merged = mergeVariables(stored.variables, patch, removals, ctx);
					absentRemovals = merged.absentRemovals;
					return { variables: merged.variables };
				},
				write: (payload, ifMatch) => ctx.client.saveGlobals(payload, signal, ifMatch),
				shape: echoShape(ctx),
			});
			return result.isError
				? result
				: withCaveat(result, absentRemovalCaveat(absentRemovals));
		},
	},
];

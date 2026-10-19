/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file environments.tools.ts
 * @brief Environment writes: create, update, activate and delete.
 */

import { z } from "zod";
import { precedenceNote } from "../variable-origins.js";
import { WITHHELD_VARIABLE_SENTENCE } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	confirmDestructive,
	confirmedInput,
	echoShape,
	engineErrorResult,
	errorResult,
	isRecord,
	requireStr,
	str,
	textResult,
	unchanged,
	withCaveat,
	writesDisabled,
} from "./kit.js";
import {
	absentRemovalCaveat,
	describeEnvironment,
	mergeVariables,
	removalNames,
	removeVariablesInput,
	variablesInput,
} from "./variable-blobs.js";

export const ENVIRONMENT_TOOLS: McpTool[] = [
	{
		name: "create_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			"Create an environment - a named set of {{variables}} a request resolves against. Populate it in the same call, with plain values or with the secret/type/enabled flags. The environment is created inactive: activate_environment is what makes it the one requests resolve against. Vayu assigns the id and returns it. GUARDED: requires write access to be enabled in Vayu Settings. " +
			precedenceNote(
				"An environment's variables are the top scope tier: once this one is active they shadow every collection and global of the same name."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE,
		annotations: {
			title: "Create environment",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			name: z.string().describe("Display name for the environment."),
			description: z.string().optional().describe("Optional description."),
			variables: variablesInput("the new environment"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const name = requireStr(args, "name");
			const patch = isRecord(args.variables) ? args.variables : undefined;
			if (args.variables !== undefined && patch === undefined) {
				return errorResult('"variables" must be an object mapping names to values.');
			}
			// Merged against nothing, which is what turns the string form into a
			// stored entry and enforces "a new variable carries a value" - on a
			// create every variable is new.
			const merged = mergeVariables({}, patch, [], ctx);
			// No `id`: the engine assigns every id it stores and answers a body
			// carrying one with a 400 (issue #97), so the tool does not offer a
			// field it would only have to refuse.
			const payload: Record<string, unknown> = { name, variables: merged.variables };
			const description = str(args, "description");
			if (description !== undefined) payload.description = description;
			return callEngine(
				ctx,
				() => ctx.client.createEnvironment(payload, signal),
				echoShape(ctx)
			);
		},
	},
	{
		name: "update_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			"Set, re-flag or remove an environment's variables, and rename it. Merges: variables you do not name are left alone, and a named one keeps every flag you do not state - so rotating a secret leaves it masked and writing to a disabled variable leaves it disabled. Pass a variable as a string to set its value, or as an object to set any of value/secret/type/enabled. removeVariables deletes names outright, which blanking a value cannot do. GUARDED: requires write access to be enabled in Vayu Settings. " +
			precedenceNote(
				"An environment's variables are the top scope tier: while this environment is active they shadow every collection and global of the same name. Writing here to an inactive environment changes nothing a request resolves until activate_environment makes it current."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE,
		annotations: {
			title: "Update environment",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z.string().describe("Environment ID to update."),
			variables: variablesInput("this environment"),
			removeVariables: removeVariablesInput("this environment"),
			name: z.string().optional().describe("Optional new name for the environment."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const environmentId = requireStr(args, "environmentId");
			const patch = isRecord(args.variables) ? args.variables : undefined;
			if (args.variables !== undefined && patch === undefined) {
				return errorResult('"variables" must be an object mapping names to values.');
			}
			const removals = removalNames(args);
			const rename = str(args, "name");
			if (patch === undefined && removals.length === 0 && rename === undefined) {
				return errorResult(
					'Pass at least one change: "variables", "removeVariables" or "name".'
				);
			}
			// Fetch the current env so we merge (the PUT replaces the whole blob)
			// and keep the existing name (which the engine requires).
			let existing: Record<string, unknown>;
			try {
				existing = ((await ctx.client.getEnvironment(environmentId, signal)) ??
					{}) as Record<string, unknown>;
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			const merged = mergeVariables(existing.variables, patch, removals, ctx);
			// PUT carries the id in the path, so the body is the patch only. The
			// name is still sent because the engine treats it as having no
			// default - omitting it would keep the stored name, but sending the
			// caller's rename in the same call is the point of the `name` arg.
			const payload: Record<string, unknown> = {
				name: rename ?? (typeof existing.name === "string" ? existing.name : ""),
				variables: merged.variables,
			};
			const result = await callEngine(
				ctx,
				() => ctx.client.updateEnvironment(environmentId, payload, signal),
				echoShape(ctx)
			);
			return result.isError
				? result
				: withCaveat(result, absentRemovalCaveat(merged.absentRemovals));
		},
	},
	{
		name: "activate_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			'Make an environment the active one - the set {{variables}} resolve against when a call names no environmentId of its own, and what the app\'s own switcher shows. Exactly one environment is active at a time: activating one deactivates the previous in the same write. Pass "none" to leave no environment active, the switcher\'s "No Environment" option. Tools that take an explicit environmentId (run_request, start_load_run, run_collection) are unaffected by this - it is the default, not an override. GUARDED: requires write access to be enabled in Vayu Settings. ' +
			precedenceNote(
				"This is the one call that changes which tier answers without changing any value: the newly active environment shadows every collection and global of the same name, so a name can start resolving differently with nothing else edited."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE,
		annotations: {
			title: "Activate environment",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z
				.string()
				.describe('Environment ID to activate, or "none" to leave none active.'),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const environmentId = requireStr(args, "environmentId");
			if (environmentId !== "none") {
				// `isActive: true` is the whole switch: the DB layer clears the
				// previously active row in the same transaction
				// (`deactivate_other_environments_locked`), so a companion write
				// would be a second definition of the same rule. No `name` - absent
				// on a PUT means keep.
				return callEngine(
					ctx,
					() => ctx.client.updateEnvironment(environmentId, { isActive: true }, signal),
					echoShape(ctx)
				);
			}
			// There is no "no environment" row to write true to, so clearing is
			// spelled as deactivating whichever row holds the flag - the same shape
			// `useSetActiveEnvironmentMutation` sends. Which row that is has to be
			// read: the engine has no "deactivate all" verb.
			let active: Record<string, unknown> | undefined;
			try {
				const listed = await ctx.client.listEnvironments(signal);
				const rows = Array.isArray(listed) ? listed : [];
				active = rows.find((row) => isRecord(row) && row.isActive === true) as
					Record<string, unknown> | undefined;
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			const activeId = active && typeof active.id === "string" ? active.id : undefined;
			if (activeId === undefined) {
				// Successful and deliberately without effect, so it emits no
				// data-changed event - there is nothing for the renderer to refetch.
				return unchanged(
					textResult("No environment was active, so there was nothing to deactivate.")
				);
			}
			return callEngine(
				ctx,
				() => ctx.client.updateEnvironment(activeId, { isActive: false }, signal),
				echoShape(ctx)
			);
		},
	},
	{
		name: "delete_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			"Delete an environment and every variable in it. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the environment's name and how many variables go with it; otherwise call once for a preview, then again with `confirmed: true`. There is no undo, and a saved request that referenced those variables keeps its {{placeholders}} with nothing to resolve them.",
		annotations: {
			title: "Delete environment",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z.string().describe("Environment ID to delete."),
			confirmed: confirmedInput("actually delete the environment and its variables"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const environmentId = requireStr(args, "environmentId");
			// Read it first so the prompt names the environment and its variable
			// count rather than an id - the read-before-prompt every delete here
			// does. `getEnvironment` resolves from the list (the engine has no
			// `GET /environments/:id`) and answers null for an id nothing matches.
			let environment: Record<string, unknown>;
			try {
				const found = await ctx.client.getEnvironment(environmentId, signal);
				if (!isRecord(found))
					return errorResult(`No environment with id "${environmentId}".`);
				environment = found;
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			const subject = describeEnvironment(environmentId, environment);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete ${subject}?\n\nEvery variable in it goes with it. This cannot be undone.`,
				acceptTitle: "Delete the environment",
				acceptDescription: "Confirm to delete this environment and its variables.",
				declined: "Environment not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete ${subject}, along with every variable in it. This cannot be undone.\n\n` +
					"This is a preview. To delete it, call delete_environment again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(ctx, () => ctx.client.deleteEnvironment(environmentId, signal));
		},
	},
];

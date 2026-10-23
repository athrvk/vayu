/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file variable-blobs.ts
 * @brief Read-merge-write for the variable blobs environments and globals keep.
 *
 * Environments and globals store their variables as one JSON blob that every
 * write replaces wholesale (`PUT /environments/:id`, `POST /globals`), so
 * "change one variable" is always read-merge-write here. One implementation for
 * both, because the two blobs have the same shape and the same invariant
 * (issue #314): a write must carry forward the flags it was not asked to
 * change, or a rotated secret comes back unmasked and a disabled variable
 * silently re-enables.
 */

import { z } from "zod";
import {
	collectionChain,
	type CollectionLike,
	type OriginScopes,
	type StoredVariableBag,
	VARIABLE_PRECEDENCE_SENTENCE,
	VARIABLE_RESOLUTION_URI,
} from "../variable-origins.js";
import type { ToolContext } from "./contract.js";
import { REVEAL_SETTING_TOKEN, settingRemedy } from "../remedy.js";
import { ID_KINDS, unknownIdText } from "./failure.js";
import { isRecord, ToolArgError } from "./kit.js";

/**
 * One variable as an agent may state it: a bare value, or a value with the
 * flags the Variables drawer sets beside it.
 *
 * The string form is what `update_environment` has always taken and stays the
 * short spelling for the common case. The object form is what makes the flags
 * reachable at all - every field is optional, and an omitted one keeps whatever
 * is stored rather than resetting it, which is the same merge rule the value
 * itself follows.
 */
const VARIABLE_INPUT = z.union([
	z.string(),
	z.object({
		value: z.string().optional().describe("New value. Omitted keeps the stored one."),
		secret: z
			.boolean()
			.optional()
			.describe(
				`Treat this variable as a secret: masked in the Vayu UI, and withheld from MCP reads (\`valueWithheld: true\`) unless the user has chosen to ${REVEAL_SETTING_TOKEN}. \`true\` is always accepted; \`false\` over a stored secret is refused unless that setting is on, because it would make the value readable.`
			),
		type: z
			.enum(["string", "number", "boolean", "json"])
			.optional()
			.describe("How the app renders and validates the value."),
		enabled: z
			.boolean()
			.optional()
			.describe("Whether the variable takes part in {{...}} resolution."),
	}),
]);

/** The `variables` argument, described for whichever blob it is writing. */
export function variablesInput(subject: string) {
	return z
		.record(z.string(), VARIABLE_INPUT)
		.optional()
		.describe(
			`Variables to set on ${subject}, as a name -> value map. A value is either a string (sets the value, keeps every flag) or an object {value, secret, type, enabled} whose omitted fields keep their stored setting. A stored secret stays a secret: secret=false over one is refused unless Reveal secrets to agents is on (the user can ${REVEAL_SETTING_TOKEN}). Merges: variables not named here are left alone. ${VARIABLE_PRECEDENCE_SENTENCE} A name defined in a higher tier shadows what you write here - see ${VARIABLE_RESOLUTION_URI}.`
		);
}

/** The stored `variables` blob off a collection / environment / globals row. */
function variableBagOf(row: unknown): StoredVariableBag | undefined {
	if (!isRecord(row)) return undefined;
	const bag = row.variables;
	return isRecord(bag) ? (bag as StoredVariableBag) : undefined;
}

/**
 * The environment row a call resolves against, for `resolve_variables` and for
 * every send (through `resolveEnvironmentId`), so the preview and the send
 * cannot disagree (#2480).
 *
 * Three cases, deliberately distinct: a named id must exist (a typo resolving
 * silently against no environment, or the active one, would report confident,
 * wrong answers), `"none"` is the explicit no-environment case that
 * `activate_environment` already spells that way, and an omitted id means the
 * active row, as in the app's Send. Read through the raw list: only `id` and
 * `isActive` decide, nothing a value-withholding rule governs.
 */
export async function selectEnvironment(
	ctx: ToolContext,
	environmentId: string | undefined,
	signal?: AbortSignal
): Promise<Record<string, unknown> | undefined> {
	if (environmentId === "none") return undefined;
	const listed = await ctx.client.listEnvironments(signal);
	const rows = Array.isArray(listed) ? listed : [];
	if (environmentId !== undefined && environmentId !== "") {
		const found = rows.find((row) => isRecord(row) && row.id === environmentId);
		if (!found)
			throw new ToolArgError(unknownIdText(ID_KINDS.environment, environmentId), "not_found");
		return found as Record<string, unknown>;
	}
	return rows.find((row) => isRecord(row) && row.isActive === true) as
		Record<string, unknown> | undefined;
}

/**
 * Read every scope `resolve_variables` needs, in one pass over the engine's
 * lists. Globals are always read; the collection chain and the environment only
 * when the context names them.
 *
 * A `collectionId` that names nothing is refused rather than resolved as an
 * empty chain: "this collection defines none of these" and "there is no such
 * collection" are different answers, and an agent acting on the first when the
 * second is true writes to a collection that does not exist.
 */
export async function gatherVariableScopes(
	ctx: ToolContext,
	collectionId: string | undefined,
	environmentId: string | undefined,
	signal?: AbortSignal
): Promise<OriginScopes> {
	const globals = variableBagOf(await ctx.client.getGlobals(signal));

	let chain: OriginScopes["chain"];
	if (collectionId !== undefined && collectionId !== "") {
		const listed = await ctx.client.listCollections(signal);
		const rows = (Array.isArray(listed) ? listed : []) as CollectionLike[];
		chain = collectionChain(rows, collectionId);
		if (chain.length === 0)
			throw new ToolArgError(unknownIdText(ID_KINDS.collection, collectionId), "not_found");
	}

	let environment: OriginScopes["environment"];
	const row = await selectEnvironment(ctx, environmentId, signal);
	if (row) {
		environment = {
			id: typeof row.id === "string" ? row.id : undefined,
			name: typeof row.name === "string" ? row.name : undefined,
			variables: variableBagOf(row),
		};
	}

	return { globals, chain, environment };
}

/**
 * What context the answer was computed in, echoed back so a report can be read
 * without re-deriving it. The environment is stated even when there is none:
 * "no environment was active" is why a value came from a collection, and an
 * omitted key would leave that to be guessed.
 */
export function describeScopes(
	scopes: OriginScopes,
	collectionId: string | undefined,
	environmentId: string | undefined
): Record<string, unknown> {
	return {
		collectionId: collectionId ?? null,
		collectionChain: (scopes.chain ?? []).map((c) => ({ id: c.id, name: c.name })),
		environmentId: scopes.environment?.id ?? null,
		environmentName: scopes.environment?.name ?? null,
		environmentSelection:
			environmentId === "none"
				? "explicitly none"
				: environmentId
					? "named by the caller"
					: scopes.environment
						? "the active environment"
						: "no environment is active",
	};
}

/** The `removeVariables` argument - the delete a blank value cannot express. */
export function removeVariablesInput(subject: string) {
	return z
		.array(z.string())
		.optional()
		.describe(
			`Variable names to delete from ${subject} outright. Setting a variable to an empty string leaves the name resolving to nothing; this removes it. A name that is not there is reported, not an error.`
		);
}

/**
 * Read the `variables` argument as a patch, refusing anything that is not a
 * name -> value map.
 *
 * The throwing form of the check `create_environment` / `update_environment`
 * make inline (`dispatchTool` turns a `ToolArgError` into the same tool error
 * their `errorResult` produces, with the same message). It is a function here
 * because the collection tools take the argument at two more call sites, and a
 * fourth hand-written copy of "is this an object" is how the four start
 * disagreeing about what a malformed one does.
 */
export function readVariablesPatch(
	args: Record<string, unknown>
): Record<string, unknown> | undefined {
	const value = args.variables;
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		throw new ToolArgError('"variables" must be an object mapping names to values.');
	}
	return value;
}

/** Read and validate `removeVariables` off raw arguments. */
export function removalNames(args: Record<string, unknown>): string[] {
	const value = args.removeVariables;
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || name === "")) {
		throw new ToolArgError('"removeVariables" must be an array of variable names.');
	}
	return value as string[];
}

interface MergedVariables {
	/** The whole blob to write back. */
	variables: Record<string, unknown>;
	/** Names `removeVariables` asked for that the blob did not hold. */
	absentRemovals: string[];
}

/**
 * Lay a caller's patch over a stored variables blob.
 *
 * Removals run first and a name in both lists is refused rather than resolved:
 * "set it and delete it" has no correct order, so guessing one would apply half
 * of what the caller asked for and report success.
 *
 * A new variable must carry a value. Without that rule `{secret: true}` against
 * a mistyped name creates an empty secret variable and reports success - the
 * typo becomes a variable rather than an error. "New" covers a stored entry
 * that is not usable either (a bare string off disk, `lib/variable-resolution.ts`
 * D17), since there is no value there to keep.
 *
 * With `revealSecretsToAgents` off, `secret: false` over a stored `secret: true` is
 * refused (#1809): the call would turn a withheld value into one the next read
 * returns, which is the switch the user has not thrown. `secret: true` and every
 * other edit pass, and so does everything once reveal is on. Removing and
 * re-creating a variable is not covered.
 */
export function mergeVariables(
	stored: unknown,
	patch: Record<string, unknown> | undefined,
	removals: readonly string[],
	ctx: ToolContext
): MergedVariables {
	const merged: Record<string, unknown> = isRecord(stored) ? { ...stored } : {};
	const absentRemovals: string[] = [];
	const held = (name: string) => Object.prototype.hasOwnProperty.call(merged, name);

	for (const name of removals) {
		if (patch && Object.prototype.hasOwnProperty.call(patch, name)) {
			throw new ToolArgError(
				`"${name}" is named in both "variables" and "removeVariables". Pick one.`
			);
		}
		if (held(name)) delete merged[name];
		else absentRemovals.push(name);
	}

	for (const [name, input] of Object.entries(patch ?? {})) {
		const prev = merged[name];
		// The object guard keeps a malformed stored entry (a bare string, an
		// array) from spreading into index-keyed garbage - it is replaced with a
		// sane entry rather than merged onto.
		const base = isRecord(prev) ? prev : {};
		if (typeof input === "string") {
			// `enabled` leads the spread so a new (or malformed) entry defaults to
			// enabled while an existing explicit flag survives: writing a value
			// must not silently re-enable a variable the user disabled.
			merged[name] = { enabled: true, ...base, value: input };
			continue;
		}
		if (!isRecord(input)) {
			throw new ToolArgError(
				`"${name}" must be a string value, or an object with any of value, secret, type, enabled.`
			);
		}
		const stated: Record<string, unknown> = {};
		for (const field of ["value", "secret", "type", "enabled"] as const) {
			if (input[field] !== undefined) stated[field] = input[field];
		}
		if (stated.value === undefined && typeof base.value !== "string") {
			throw new ToolArgError(
				`"${name}" has no stored value to keep, so this call has to give it one: pass a string, or an object carrying "value".`
			);
		}
		if (!ctx.config.revealSecretsToAgents && stated.secret === false && base.secret === true) {
			throw new ToolArgError(
				`"${name}" is a secret, and this call would make it readable. Agents cannot clear "secret" while Reveal secrets to agents is off - ask the user to ${settingRemedy("revealSecretsToAgents", ctx.host)}, or to clear the flag in the app's Variables drawer.`,
				"policy"
			);
		}
		merged[name] = { enabled: true, ...base, ...stated };
	}

	return { variables: merged, absentRemovals };
}

/**
 * What a removal list asked for and did not find, said in band.
 *
 * A name that was not there is not an error - a retried call whose first
 * attempt landed would otherwise fail on its own success - but it is not
 * nothing either: silence would let a mistyped name read as a variable
 * removed.
 */
export function absentRemovalCaveat(names: readonly string[]): string {
	if (names.length === 0) return "";
	return `\n\nNothing to remove for: ${names.join(", ")} - no variable of that name was stored.`;
}

/**
 * An environment named in words, for the prompt that asks a human to delete it.
 *
 * The variable count is the part that has to be there, for the reason
 * `describeInbox`'s capture count is: an environment holding 20 variables and an
 * empty one are the same call with very different consequences. Whether it is
 * the *active* environment is the other half - deleting that one also drops
 * whatever every unsent tab was resolving against.
 */
export function describeEnvironment(
	environmentId: string,
	environment: Record<string, unknown>
): string {
	const name =
		typeof environment.name === "string" && environment.name !== ""
			? environment.name
			: environmentId;
	const count = isRecord(environment.variables) ? Object.keys(environment.variables).length : 0;
	const parts = [`${count} variable${count === 1 ? "" : "s"}`];
	if (environment.isActive === true) parts.push("currently active");
	return `the environment "${name}" (${parts.join(", ")})`;
}

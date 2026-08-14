/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which data contract answers for a request, and what a `{{data.*}}` token
 * should say about itself (issue #600, phase 2 of #598).
 *
 * Phase 1 put the columns on a collection. This is the rule that decides which
 * collection's columns a given request is checked against: **the nearest
 * declared ancestor, leaf to root** - the same shape as the variable chain
 * (`useVariableResolver`: environment > collection chain leaf->root > global),
 * so a sub-collection run recursively under a parent binds the parent's data
 * and finds the parent's contract when it declares none of its own. The rule is
 * documented for users in `docs/app/variable-resolution.md`.
 *
 * Nearest *declared*, not nearest declaring-or-not: a sub-collection that
 * declares nothing is transparent rather than a contract of zero columns.
 * Declaring `{}` is how a collection says "no contract" (see
 * `hasDataContract`), and treating that as an override would make an empty
 * declaration silently shadow a working one above it.
 *
 * Pure, and separate from the hook that feeds it, because three surfaces read
 * the same answer - the token painter, the completion providers and the Data
 * tab's audit - and a second copy of the walk is the defect this repo keeps
 * finding.
 */

import { collectSubtreeIds, walkAncestors, type TreeNode } from "@/modules/collections/tree-utils";
import { hasDataContract, type CollectionDataSchema, type DataContractScope } from "@/types/domain";
import { dataColumnName } from "./variable-resolution";

/** The minimum a contract walk needs from a collection row. */
export interface ContractNode extends TreeNode {
	name: string;
	dataSchema?: CollectionDataSchema;
}

/**
 * The contract in scope for `collectionId`, or null when no collection in its
 * chain declares one.
 *
 * `walkAncestors` returns the chain root-first and carries the cycle guard, so
 * this reads it backwards to get leaf-first without walking `parentId` itself.
 */
export function resolveDataContract(
	collectionId: string | null | undefined,
	collections: readonly ContractNode[]
): DataContractScope | null {
	if (!collectionId) return null;
	const chain = walkAncestors(collectionId, collections);
	for (let i = chain.length - 1; i >= 0; i--) {
		const collection = chain[i];
		if (!hasDataContract(collection.dataSchema)) continue;
		return {
			collectionName: collection.name,
			columns: collection.dataSchema?.columns ?? [],
		};
	}
	return null;
}

/**
 * The collections whose requests `rootId`'s contract answers for: itself, plus
 * every descendant down to - but not including - one that declares a contract
 * of its own.
 *
 * The audit needs this rather than the collection's own requests, because the
 * chain rule is what makes a `{{data.email}}` in a sub-collection *this*
 * contract's business. Auditing the leaf alone would report a column as
 * unreferenced while a request one level down references it, which is the
 * reading that gets a working column deleted.
 */
export function collectionsUnderContract(
	rootId: string,
	collections: readonly ContractNode[]
): string[] {
	return collectSubtreeIds(
		rootId,
		collections,
		(collection) => !hasDataContract(collection.dataSchema)
	);
}

/**
 * The three states a `{{data.*}}` token can be in, which is the whole of what
 * phase 2 adds to the painting phase 1 left neutral.
 *
 * `muted` for both readable states and `warning` for the one that needs
 * attention - never `destructive`, which is reserved for a name nothing can
 * ever bind. An undeclared column is not broken: the contract may simply be out
 * of date, and the run is still the user's to start.
 */
export type DataTokenTone = "muted" | "warning";

export interface DataTokenDescription {
	tone: DataTokenTone;
	/** The tooltip's first line - what the token stands for. */
	description: string;
	/** The tooltip's trailing note - when, or against what, it is decided. */
	note: string;
}

/** `a, b, c` - the declared list as a tooltip prints it. */
function columnList(columns: string[]): string {
	return columns.join(", ");
}

/**
 * What the token says about itself, given the contract in scope.
 *
 * Three states, and the middle one is the reason the phase exists:
 *
 * - **No contract anywhere in the chain** - phase 1's neutral wording, kept
 *   exactly: nothing has been declared, so nothing can be validated, and a
 *   token painted amber for lacking a contract nobody wrote would be noise.
 * - **A declared column** - informational, and the tooltip names the declaring
 *   collection so the reader knows which Data tab owns it.
 * - **A column no contract in scope declares** - warning. The run will send the
 *   braces literally unless the file happens to carry the column anyway, and
 *   the declared list is printed because the fix is nearly always a typo.
 */
export function describeDataToken(
	name: string,
	contract: DataContractScope | null | undefined
): DataTokenDescription {
	const column = dataColumnName(name);
	if (!contract || !column) {
		return {
			tone: "muted",
			description: "Bound by the run's data file",
			note: "per iteration",
		};
	}
	if (contract.columns.includes(column)) {
		return {
			tone: "muted",
			description: "Data column - bound per iteration",
			note: `declared in ${contract.collectionName}`,
		};
	}
	return {
		tone: "warning",
		description: `Not a declared column of ${contract.collectionName}`,
		note: `declared: ${columnList(contract.columns)}`,
	};
}

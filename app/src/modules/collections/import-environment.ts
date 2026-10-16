/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an import does about the active environment (issue #2115).
 *
 * An import that creates exactly one environment and finds none active makes it
 * the active one: that is the one case where the user has already said which
 * environment they mean, and without it every `{{variable}}` in the file they
 * just imported resolves to nothing until they find the switcher. Anything else
 * changes nothing - a second environment would be a guess, and an active
 * environment is the user's own choice to override.
 *
 * "None active" is read from the engine after the apply, never from the session
 * store: the store is a per-window cache of a choice the engine persists, and a
 * fresh install or a second window can disagree with it.
 */

import { useEnvSwitcherStore, useToastStore } from "@/stores";
import type { ToastAction } from "@/stores/toast-store";
import type { Environment } from "@/types";

/** The decision, before anything is written. */
export type EnvironmentPlan =
	| { kind: "none" }
	| { kind: "activate"; id: string; name: string }
	| { kind: "keep"; id: string; name: string; activeName: string }
	| { kind: "choose"; count: number };

/**
 * `createdIds` is every environment the whole batch created, across all files;
 * `environments` is the engine's list after the apply.
 */
export function planEnvironmentActivation(
	createdIds: readonly string[],
	environments: readonly Environment[]
): EnvironmentPlan {
	if (createdIds.length === 0) return { kind: "none" };
	const active = environments.find((e) => e.isActive);
	if (createdIds.length > 1) {
		return active ? { kind: "none" } : { kind: "choose", count: createdIds.length };
	}
	const created = environments.find((e) => e.id === createdIds[0]);
	if (!created) return { kind: "none" };
	return active
		? { kind: "keep", id: created.id, name: created.name, activeName: active.name }
		: { kind: "activate", id: created.id, name: created.name };
}

/** What happened, for the toast. */
export type EnvironmentOutcome =
	| { kind: "activated"; name: string }
	| { kind: "kept"; name: string; activeName: string; use: () => void }
	| { kind: "choose"; count: number }
	| { kind: "failed"; name: string };

export interface EnvironmentActivationDeps {
	/** The engine's environments right now, not a cached list. */
	listEnvironments: () => Promise<Environment[]>;
	activate: (id: string) => Promise<void>;
}

/**
 * Plan and, where the plan says so, carry out the activation.
 *
 * Resolves `null` when there is nothing to say. That includes a list the engine
 * would not give: the import itself succeeded, so not knowing whether an
 * environment is active changes nothing rather than failing the import.
 * A rejected activation is `failed`, not an error for the same reason.
 */
export async function activateImportedEnvironment(
	createdIds: readonly string[],
	deps: EnvironmentActivationDeps
): Promise<EnvironmentOutcome | null> {
	if (createdIds.length === 0) return null;
	let plan: EnvironmentPlan;
	try {
		plan = planEnvironmentActivation(createdIds, await deps.listEnvironments());
	} catch {
		return null;
	}
	switch (plan.kind) {
		case "none":
			return null;
		case "choose":
			return plan;
		case "keep":
			return {
				kind: "kept",
				name: plan.name,
				activeName: plan.activeName,
				use: () => void switchToImported(plan.id, plan.name, deps.activate),
			};
		case "activate":
			try {
				await deps.activate(plan.id);
				return { kind: "activated", name: plan.name };
			} catch {
				return { kind: "failed", name: plan.name };
			}
	}
}

/** The toast action's activation, which is the user's own switch and reports like the title bar's. */
async function switchToImported(
	id: string,
	name: string,
	activate: EnvironmentActivationDeps["activate"]
): Promise<void> {
	const { showToast } = useToastStore.getState();
	try {
		await activate(id);
		showToast({ message: `Environment: ${name}`, variant: "info" });
	} catch (error) {
		const fallback = "Couldn't switch environment";
		showToast({
			message: error instanceof Error ? `${fallback}: ${error.message}` : fallback,
			variant: "error",
		});
	}
}

/**
 * The clause that joins the import toast's one sentence, after its `;`. It
 * starts lower-case for that reason.
 */
export function environmentClause(outcome: EnvironmentOutcome): string {
	switch (outcome.kind) {
		case "activated":
			return `"${outcome.name}" is now the active environment`;
		case "kept":
			return `"${outcome.activeName}" is still the active environment`;
		case "choose":
			return "no environment is active yet";
		case "failed":
			return `couldn't make "${outcome.name}" the active environment`;
	}
}

const CHOOSE_ENVIRONMENT: ToastAction = {
	label: "Choose environment",
	onClick: () => useEnvSwitcherStore.getState().setOpen(true),
};

/** The action the outcome offers, or `undefined` where it is complete as a sentence. */
export function environmentAction(outcome: EnvironmentOutcome): ToastAction | undefined {
	switch (outcome.kind) {
		case "activated":
			return undefined;
		case "kept":
			return { label: `Use "${outcome.name}"`, onClick: outcome.use };
		case "choose":
		case "failed":
			return CHOOSE_ENVIRONMENT;
	}
}

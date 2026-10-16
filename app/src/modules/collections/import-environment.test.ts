/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The rule behind the active environment after an import (#2115): exactly one
 * environment created and none active on the engine activates it; every other
 * combination changes nothing.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	activateImportedEnvironment,
	environmentAction,
	environmentClause,
	planEnvironmentActivation,
	type EnvironmentOutcome,
} from "./import-environment";
import { useEnvSwitcherStore, useToastStore } from "@/stores";
import type { Environment } from "@/types";

function env(id: string, name: string, isActive = false): Environment {
	return { id, name, description: "", variables: {}, isActive, createdAt: "", updatedAt: "" };
}

const staging = env("env_1", "Staging");
const dev = env("env_2", "Dev");
const production = env("env_3", "Production", true);

describe("planEnvironmentActivation", () => {
	it("activates the one created environment when none is active", () => {
		expect(planEnvironmentActivation(["env_1"], [staging, dev])).toEqual({
			kind: "activate",
			id: "env_1",
			name: "Staging",
		});
	});

	it("keeps the active one and names it when one environment was created", () => {
		expect(planEnvironmentActivation(["env_1"], [staging, production])).toEqual({
			kind: "keep",
			id: "env_1",
			name: "Staging",
			activeName: "Production",
		});
	});

	it("asks the user to choose when several were created and none is active", () => {
		expect(planEnvironmentActivation(["env_1", "env_2"], [staging, dev])).toEqual({
			kind: "choose",
			count: 2,
		});
	});

	it("says nothing when several were created and one is already active", () => {
		expect(planEnvironmentActivation(["env_1", "env_2"], [staging, dev, production])).toEqual({
			kind: "none",
		});
	});

	it("does nothing when no environment was created, active or not", () => {
		expect(planEnvironmentActivation([], [production])).toEqual({ kind: "none" });
		expect(planEnvironmentActivation([], [staging])).toEqual({ kind: "none" });
	});

	it("does nothing when the created environment is no longer in the engine's list", () => {
		expect(planEnvironmentActivation(["env_9"], [dev])).toEqual({ kind: "none" });
	});
});

describe("activateImportedEnvironment", () => {
	const deps = (environments: Environment[]) => ({
		listEnvironments: vi.fn().mockResolvedValue(environments),
		activate: vi.fn().mockResolvedValue(undefined),
	});

	beforeEach(() => useToastStore.setState({ toasts: [] }));

	it("writes the activation and reports it", async () => {
		const d = deps([staging]);

		await expect(activateImportedEnvironment(["env_1"], d)).resolves.toEqual({
			kind: "activated",
			name: "Staging",
		});
		expect(d.activate).toHaveBeenCalledExactlyOnceWith("env_1");
	});

	it("reports a refused activation instead of throwing", async () => {
		const d = deps([staging]);
		d.activate.mockRejectedValue(new Error("engine said no"));

		await expect(activateImportedEnvironment(["env_1"], d)).resolves.toEqual({
			kind: "failed",
			name: "Staging",
		});
	});

	it("does not read the engine at all when nothing was created", async () => {
		const d = deps([production]);

		await expect(activateImportedEnvironment([], d)).resolves.toBeNull();
		expect(d.listEnvironments).not.toHaveBeenCalled();
	});

	it("writes nothing when another environment is active, and activates on request", async () => {
		const d = deps([staging, production]);

		const outcome = await activateImportedEnvironment(["env_1"], d);

		expect(outcome).toMatchObject({ kind: "kept", name: "Staging", activeName: "Production" });
		expect(d.activate).not.toHaveBeenCalled();
		(outcome as Extract<EnvironmentOutcome, { kind: "kept" }>).use();
		await vi.waitFor(() =>
			expect(useToastStore.getState().toasts[0]?.message).toBe("Environment: Staging")
		);
		expect(d.activate).toHaveBeenCalledExactlyOnceWith("env_1");
	});

	it("tells the user when their own switch is refused", async () => {
		const d = deps([staging, production]);
		d.activate.mockRejectedValue(new Error("engine said no"));

		const outcome = await activateImportedEnvironment(["env_1"], d);
		(outcome as Extract<EnvironmentOutcome, { kind: "kept" }>).use();

		await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
		expect(useToastStore.getState().toasts[0]).toMatchObject({
			message: "Couldn't switch environment: engine said no",
			variant: "error",
		});
	});

	it("changes nothing when the engine will not say what is active", async () => {
		const d = deps([]);
		d.listEnvironments.mockRejectedValue(new Error("offline"));

		await expect(activateImportedEnvironment(["env_1"], d)).resolves.toBeNull();
		expect(d.activate).not.toHaveBeenCalled();
	});
});

describe("the outcome's wording and action", () => {
	beforeEach(() => useEnvSwitcherStore.setState({ isOpen: false }));

	it("offers no action once the environment is active", () => {
		expect(environmentAction({ kind: "activated", name: "Staging" })).toBeUndefined();
		expect(environmentClause({ kind: "activated", name: "Staging" })).toBe(
			'"Staging" is now the active environment'
		);
	});

	it("opens the switcher for a refused activation and for several environments", () => {
		for (const outcome of [
			{ kind: "failed", name: "Staging" },
			{ kind: "choose", count: 3 },
		] as const) {
			useEnvSwitcherStore.setState({ isOpen: false });
			const action = environmentAction(outcome);
			expect(action?.label).toBe("Choose environment");
			action?.onClick();
			expect(useEnvSwitcherStore.getState().isOpen).toBe(true);
		}
		expect(environmentClause({ kind: "failed", name: "Staging" })).toBe(
			'couldn\'t make "Staging" the active environment'
		);
		expect(environmentClause({ kind: "choose", count: 3 })).toBe(
			"no environment is active yet"
		);
	});

	it("labels the use action with the imported environment and runs its handler", () => {
		const use = vi.fn();
		const outcome = { kind: "kept", name: "Staging", activeName: "Production", use } as const;

		const action = environmentAction(outcome);
		action?.onClick();

		expect(action?.label).toBe('Use "Staging"');
		expect(use).toHaveBeenCalledOnce();
		expect(environmentClause(outcome)).toBe('"Production" is still the active environment');
	});
});

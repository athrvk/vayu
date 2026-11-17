/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an engine start or restart that threw was, read once for both callers
 * in main.ts (`startEngine`, `restartEngine`).
 *
 * None of the outcomes closes the window or quits (#3610). The window is where
 * an engine that is not there is explained and offered back: a crashed child is
 * the lifecycle's own `crashed` state, which the Dock names beside Restart, and
 * a failure with no child to describe it is the one sentence returned here as
 * the start failure (`engine:startFailure`), which the Dock shows beside Retry.
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do.
 */

import { EngineNotReadyError, EnginePortInUseError, type EngineLifecycle } from "./sidecar.js";

/**
 * - `slow`: the readiness budget is spent but the child is alive, still working
 *   through its startup housekeeping. Not ours to kill: the renderer's health
 *   poll adopts it when it answers, and quitting here ended launches that were
 *   about to succeed.
 * - `port-in-use`: another program, or a Vayu engine serving another data
 *   directory, holds every port the engine may use; `reason` tells the user
 *   what to free before Retry.
 * - `overtaken`: the app is quitting, or a restart asked for during the start
 *   is queued behind it and answers `engine:restart` itself.
 * - `failed`: anything else. `reason` is null when the lifecycle is `crashed`,
 *   whose exit code and stderr tail already say why.
 */
export type EngineStartOutcome =
	| { kind: "slow" }
	| { kind: "port-in-use"; reason: string }
	| { kind: "overtaken" }
	| { kind: "failed"; reason: string | null };

/** The slice of `EngineSidecar` the classification reads. */
export interface EngineStartState {
	isShuttingDown(): boolean;
	hasRestartPending(): boolean;
	getLifecycle(): EngineLifecycle;
}

export function classifyEngineStartFailure(
	error: unknown,
	sidecar: EngineStartState | null
): EngineStartOutcome {
	if (error instanceof EngineNotReadyError) return { kind: "slow" };
	if (error instanceof EnginePortInUseError) {
		return { kind: "port-in-use", reason: error.message };
	}
	if (sidecar?.isShuttingDown() || sidecar?.hasRestartPending()) return { kind: "overtaken" };
	if (sidecar?.getLifecycle().kind === "crashed") return { kind: "failed", reason: null };
	return { kind: "failed", reason: describeChildlessFailure(error) };
}

/** What `engine:startFailure` should say after this outcome; null when nothing. */
export function engineStartFailureReason(outcome: EngineStartOutcome): string | null {
	return outcome.kind === "port-in-use" || outcome.kind === "failed" ? outcome.reason : null;
}

type StartFailureLog = (
	level: "info" | "warn" | "error",
	msg: string,
	fields?: Record<string, unknown>
) => void;

/** Log a first start's failure at the level its outcome deserves. Category `"main"`. */
export function logEngineStartFailure(
	outcome: EngineStartOutcome,
	error: unknown,
	log: StartFailureLog
): void {
	const fields = { error: String(error) };
	switch (outcome.kind) {
		case "slow":
			log(
				"warn",
				"Engine not ready within its budget; leaving it to the renderer's health poll",
				fields
			);
			return;
		case "port-in-use":
			log("warn", "No engine port is free; waiting for the user to retry", fields);
			return;
		case "overtaken":
			log("info", "Engine start overtaken by a quit or a restart", fields);
			return;
		case "failed":
			log("error", "Failed to start engine", fields);
			return;
	}
}

/**
 * One sentence for a start that failed before it had a child: the innermost
 * cause's first line. A restart wraps its last attempt's error (`cause`), and
 * a missing binary's message runs on into remediation paragraphs that a
 * tooltip collapses into one run-on line; the full text stays in the log.
 */
function describeChildlessFailure(error: unknown): string {
	const root = rootCause(error);
	const text = root instanceof Error ? root.message : String(root);
	const firstLine = text
		.split("\n")
		.find((line) => line.trim() !== "")
		?.trim();
	return firstLine
		? `Couldn't start Vayu's engine: ${firstLine}`
		: "Couldn't start Vayu's engine.";
}

/** Bounded, because nothing stops a `cause` chain from looping back on itself. */
const MAX_CAUSE_DEPTH = 8;

function rootCause(error: unknown): unknown {
	let root = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!(root instanceof Error) || root.cause === undefined) break;
		root = root.cause;
	}
	return root;
}

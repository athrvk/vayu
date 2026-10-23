/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main process's copy of `src/lib/execute-budget.ts` (issue #2836): the
 * abort budget for a `POST /execute`. `electron/` cannot import renderer
 * modules, so the function and its three constants are duplicated;
 * `execute-budget.parity.test.ts` holds the two to the same answer for the same
 * payload, which is what keeps the copy honest. Read that module's docblock for
 * the reasoning.
 */

/**
 * Grace on top of the engine's own bound, so the engine's TIMEOUT error - which
 * carries a proper error code and a recorded run - always arrives before this
 * client gives up. Mirrors `PROXIED_TIMEOUT_GRACE_MS` in `src/config/network.ts`.
 */
const PROXIED_TIMEOUT_GRACE_MS = 10_000;

/**
 * Ceiling of the engine's `defaultTimeout` setting (`seed_default_config` in
 * engine/src/db/database.cpp caps it at 300000). Used when the setting cannot
 * be read, so an unreadable config never shortens the budget below what the
 * engine may legitimately take.
 */
const ENGINE_MAX_DEFAULT_TIMEOUT_MS = 300_000;

/** Ceiling of the engine's `scriptTimeout` setting, used the same way. */
const ENGINE_MAX_SCRIPT_TIMEOUT_MS = 60_000;

/** The two settings the budget reads; `0` or non-finite means "unknown". */
export interface BudgetSettings {
	defaultTimeoutMs: number;
	scriptTimeoutMs: number;
}

function positive(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** True for a script element the engine will run (`enabled` absent or null counts as on). */
function isRunnableScript(element: unknown): boolean {
	const entry = asRecord(element);
	if (!entry) return false;
	if (entry.kind !== "script.pre" && entry.kind !== "script.post") return false;
	return entry.enabled !== false;
}

function runnableScriptCount(payload: Record<string, unknown> | undefined): number {
	const elements = payload?.elements;
	return Array.isArray(elements) ? elements.filter(isRunnableScript).length : 0;
}

/**
 * Worst-case duration of a `POST /execute` for this payload, plus the grace: the
 * request timeout (the payload's own `timeout`, else `defaultTimeout`, else the
 * ceiling), once for the transfer and again for an OAuth 2.0 token fetch, plus
 * `scriptTimeout` per enabled script element. Exactly timeout + grace for a
 * payload with neither.
 */
export function executeBudgetMs(payload: unknown, settings: BudgetSettings): number {
	const body = asRecord(payload);
	const requestTimeout = Math.max(
		positive(body?.timeout),
		positive(settings.defaultTimeoutMs) || ENGINE_MAX_DEFAULT_TIMEOUT_MS
	);
	const scriptTimeout = Math.min(
		positive(settings.scriptTimeoutMs) || ENGINE_MAX_SCRIPT_TIMEOUT_MS,
		ENGINE_MAX_SCRIPT_TIMEOUT_MS
	);
	const tokenFetch = asRecord(body?.auth)?.mode === "oauth2" ? requestTimeout : 0;
	return (
		requestTimeout +
		tokenFetch +
		runnableScriptCount(body) * scriptTimeout +
		PROXIED_TIMEOUT_GRACE_MS
	);
}

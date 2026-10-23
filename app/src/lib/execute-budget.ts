/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { ENGINE_MAX_DEFAULT_TIMEOUT_MS, PROXIED_TIMEOUT_GRACE_MS } from "@/config/network";

/**
 * The engine's `scriptTimeout` ceiling (`SCRIPT_TIMEOUT_MAX_MS`,
 * engine/include/vayu/core/constants.hpp), used when the setting cannot be read.
 */
export const ENGINE_MAX_SCRIPT_TIMEOUT_MS = 60_000;

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
 * How long a `POST /execute` may legitimately take, as a worst case for the
 * request being sent, plus the grace that lets the engine's own error arrive
 * before the client gives up (issue #2836).
 *
 * One call runs, in order: each pre-request script (up to `scriptTimeout`
 * apiece), the late OAuth 2.0 token fetch (bounded by the request timeout), the
 * transfer (up to the request timeout), and each test script. So the budget is
 * the request timeout - the payload's own `timeout`, else `defaultTimeout`, else
 * the 300 s ceiling when the setting is unknown - counted once for the transfer
 * and again when `auth.mode` is `oauth2`, plus `scriptTimeout` for every enabled
 * `script.pre` / `script.post` element. The engine runs each element through its
 * own deadline, so a collection's script and a request's are two budgets, not
 * one. A payload with neither OAuth nor a script is exactly timeout + grace, so
 * a hung engine is still declared dead as fast as before for the common send.
 *
 * `electron/mcp/execute-budget.ts` is the main process's copy (it cannot import
 * this module); `execute-budget.parity.test.ts` holds the two to the same answer.
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

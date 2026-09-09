/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One line describing what a configured element actually does (issue #1608),
 * shown on its card header while the row is collapsed - `in [200, 201]`,
 * `wait 500 ms`, `$.token → token (env)`. A handful of templates for the
 * kinds a user adds most; everything else, including an element nobody has
 * configured yet, falls back to the kind's own catalogue description, and a
 * kind this module has no template for falls back further to its first two
 * configured properties as `key: value`.
 */

import type { ElementDef, ElementKindSchema } from "@/types";

function asDisplay(value: unknown): string {
	if (Array.isArray(value)) return `[${value.join(", ")}]`;
	if (value !== null && typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function fallback(kind: ElementKindSchema | undefined): string {
	return kind?.description ?? "";
}

function summarizeAssertStatus(config: Record<string, unknown>, kind?: ElementKindSchema): string {
	const inCodes = config.in;
	if (Array.isArray(inCodes) && inCodes.length > 0) return `in [${inCodes.join(", ")}]`;
	const range = config.range as { min?: number; max?: number } | undefined;
	if (range && (range.min !== undefined || range.max !== undefined)) {
		return `${range.min ?? "…"} - ${range.max ?? "…"}`;
	}
	return fallback(kind);
}

function summarizeAssertJsonpath(
	config: Record<string, unknown>,
	kind?: ElementKindSchema
): string {
	const path = typeof config.path === "string" ? config.path : "";
	if (!path) return fallback(kind);
	if (config.expected !== undefined) return `${path} == ${JSON.stringify(config.expected)}`;
	if (typeof config.regex === "string" && config.regex.length > 0) {
		return `${path} matches ${config.regex}`;
	}
	if (config.exists) return `${path} exists`;
	return path;
}

function summarizeExtractJson(config: Record<string, unknown>, kind?: ElementKindSchema): string {
	const path = typeof config.path === "string" ? config.path : "";
	const variable = typeof config.variable === "string" ? config.variable : "";
	if (!path || !variable) return fallback(kind);
	const scope =
		typeof config.scope === "string" && config.scope.length > 0 ? config.scope : "env";
	return `${path} → ${variable} (${scope})`;
}

function summarizeTimerThink(config: Record<string, unknown>, kind?: ElementKindSchema): string {
	if (typeof config.ms === "number") return `wait ${config.ms} ms`;
	const gaussian = config.gaussian as { meanMs?: number } | undefined;
	if (gaussian && typeof gaussian.meanMs === "number") return `wait ~${gaussian.meanMs} ms`;
	if (typeof config.minMs === "number" && typeof config.maxMs === "number") {
		return `wait ${config.minMs}-${config.maxMs} ms`;
	}
	return fallback(kind);
}

function summarizeTimerPacing(config: Record<string, unknown>, kind?: ElementKindSchema): string {
	if (typeof config.everyMs !== "number") return fallback(kind);
	return `every ${config.everyMs} ms${config.perUser ? " · per user" : ""}`;
}

function summarizeControlIf(config: Record<string, unknown>, kind?: ElementKindSchema): string {
	return typeof config.condition === "string" && config.condition.length > 0
		? config.condition
		: fallback(kind);
}

function summarizeMetricRecord(config: Record<string, unknown>, kind?: ElementKindSchema): string {
	return typeof config.name === "string" && config.name.length > 0 ? config.name : fallback(kind);
}

function summarizeScript(config: Record<string, unknown>, kind?: ElementKindSchema): string {
	const text = typeof config.script === "string" ? config.script : "";
	const firstLine = text.split("\n").find((line) => line.trim().length > 0);
	return firstLine?.trim() || fallback(kind);
}

/** Any other kind: its first two configured properties, `key: value`. */
function summarizeGeneric(config: Record<string, unknown>, kind?: ElementKindSchema): string {
	const entries = Object.entries(config).filter(
		([, value]) => value !== undefined && value !== ""
	);
	if (entries.length === 0) return fallback(kind);
	return entries
		.slice(0, 2)
		.map(([key, value]) => `${key}: ${asDisplay(value)}`)
		.join(", ");
}

const TEMPLATES: Readonly<
	Record<string, (config: Record<string, unknown>, kind?: ElementKindSchema) => string>
> = {
	"assert.status": summarizeAssertStatus,
	"assert.jsonpath": summarizeAssertJsonpath,
	"extract.json": summarizeExtractJson,
	"timer.think": summarizeTimerThink,
	"timer.pacing": summarizeTimerPacing,
	"control.if": summarizeControlIf,
	"metric.record": summarizeMetricRecord,
	"script.pre": summarizeScript,
	"script.post": summarizeScript,
	"script.setup": summarizeScript,
	"script.teardown": summarizeScript,
};

export function summarizeElement(element: ElementDef, kind: ElementKindSchema | undefined): string {
	const template = TEMPLATES[element.kind] ?? summarizeGeneric;
	return template(element.config, kind);
}

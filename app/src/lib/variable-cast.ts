
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * castByType
 *
 * Coerces a stored variable's raw string `value` into its declared type
 * (`'string' | 'number' | 'boolean' | 'json'`). The on-disk shape is always a
 * string — `type` is a UI/script hint per the data-model PRD §5.2 — so this is
 * where the cast happens at read time.
 *
 * Rules (matches the PRD's expected behavior):
 *   - string  → returned as-is
 *   - number  → Number(value); invalid → NaN (caller decides what to do)
 *   - boolean → "true"/"1"/"yes" → true; "false"/"0"/"no"/"" → false; else falls back to Boolean(value)
 *   - json    → JSON.parse(value); on parse error, returns the raw string
 *
 * This utility is also used engine-side conceptually; the engine has its own
 * castByType in C++/QuickJS that mirrors these rules.
 */

import type { VariableValue } from "@/types";

export type VariableType = NonNullable<VariableValue["type"]>;

export function castByType(value: string, type?: VariableType): unknown {
	const t: VariableType = type ?? "string";
	switch (t) {
		case "string":
			return value;
		case "number":
			return value === "" ? Number.NaN : Number(value);
		case "boolean":
			return parseBoolean(value);
		case "json":
			try {
				return JSON.parse(value);
			} catch {
				// Surface the raw string so the consumer can see why parsing failed
				// instead of swallowing the value entirely.
				return value;
			}
	}
}

/** Cast a VariableValue using its declared `type` field (defaults to string). */
export function castVariable(v: VariableValue): unknown {
	return castByType(v.value, v.type);
}

function parseBoolean(value: string): boolean {
	const lowered = value.trim().toLowerCase();
	if (lowered === "true" || lowered === "1" || lowered === "yes") return true;
	if (lowered === "false" || lowered === "0" || lowered === "no" || lowered === "") return false;
	return Boolean(value);
}

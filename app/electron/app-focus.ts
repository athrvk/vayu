/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the user has open in the window, as the main process knows it, so the
 * MCP server can answer "the request I have open" (issue #2045).
 *
 * The renderer owns the record (the tabs and session stores) and pushes a
 * snapshot over `app:focus` on launch and on every change; this holds the
 * latest one. A tool call never waits on the renderer, so the copy is at most
 * one event stale - the trade `dataFile:locations` already made.
 *
 * **Names and ids only.** The snapshot is renderer input, so it is rebuilt
 * field by field into strings and nothing else: whatever else the renderer
 * sends never reaches an agent. The renderer is responsible for what goes
 * *into* a label (`hooks/useAppFocusMirror.ts` keeps URL-derived text out of
 * it); this module bounds its shape and its length.
 */

/**
 * The tab kinds a snapshot may name. Mirrors `TabType` in
 * `src/stores/tabs-store.ts`, which the main process cannot import; the test
 * beside this file reads that union and fails if the two drift.
 */
export const FOCUS_TAB_TYPES = [
	"welcome",
	"request",
	"collection",
	"dashboard",
	"run",
	"variables",
	"settings",
	"inbox",
	"mock-server",
] as const;

export type FocusTabType = (typeof FOCUS_TAB_TYPES)[number];

export interface AppFocusTab {
	type: FocusTabType;
	/** The request, collection, run, inbox or mock id by `type`; null for a singleton. */
	entityId: string | null;
	label: string;
}

export interface AppFocusEnvironment {
	id: string;
	name: string;
}

export interface AppFocus {
	activeTab: AppFocusTab | null;
	activeEnvironment: AppFocusEnvironment | null;
}

/** Longer than any id or name the app produces; a longer string is not one of them. */
const MAX_TEXT_LENGTH = 256;

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/** An id is kept whole or not at all: a truncated id names some other entity. */
const asId = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH ? value : null;

const asText = (value: unknown): string | null =>
	typeof value === "string" ? value.slice(0, MAX_TEXT_LENGTH) : null;

const isTabType = (value: unknown): value is FocusTabType =>
	(FOCUS_TAB_TYPES as readonly unknown[]).includes(value);

function normalizeTab(value: unknown): AppFocusTab | null {
	const tab = asRecord(value);
	if (!tab || !isTabType(tab.type)) return null;
	const label = asText(tab.label);
	if (label === null) return null;
	if (tab.entityId === null) return { type: tab.type, entityId: null, label };
	const entityId = asId(tab.entityId);
	return entityId === null ? null : { type: tab.type, entityId, label };
}

function normalizeEnvironment(value: unknown): AppFocusEnvironment | null {
	const environment = asRecord(value);
	if (!environment) return null;
	const id = asId(environment.id);
	const name = asText(environment.name);
	return id === null || name === null ? null : { id, name };
}

/**
 * The snapshot a published payload amounts to, or undefined when it is not one.
 * Both halves must be present: an object naming neither would read as "nothing
 * is open", which is an answer the renderer never gave.
 */
export function normalizeAppFocus(payload: unknown): AppFocus | undefined {
	const focus = asRecord(payload);
	if (!focus || !("activeTab" in focus) || !("activeEnvironment" in focus)) return undefined;
	return {
		activeTab: normalizeTab(focus.activeTab),
		activeEnvironment: normalizeEnvironment(focus.activeEnvironment),
	};
}

export class AppFocusStore {
	private focus: AppFocus | undefined;

	/** Replace the whole copy: the renderer always publishes the full snapshot. */
	replace(payload: unknown): void {
		this.focus = normalizeAppFocus(payload);
	}

	/** Undefined until a window has published, and after a payload that was not one. */
	get(): AppFocus | undefined {
		return this.focus;
	}
}

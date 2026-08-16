/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Engine settings category registry
 *
 * The seven engine categories, declared once and in sidebar order - mirroring
 * `app-panels.ts` on the client side.
 *
 * This replaces two hand-maintained maps: `ENGINE_CATEGORY_META` in the sidebar
 * tree (label + icon) and `CATEGORY_TITLES` in the settings main view (title +
 * description). They named the same five categories with two independently
 * edited copies of the label, and the sidebar's order was whatever
 * `Object.keys` returned. An array fixes both: one label per category, and the
 * order is written down.
 *
 * **Order is by likelihood of visit** (#586), not by how the engine happens to
 * seed them. It used to put the least-visited category second and the one users
 * arrive with questions about last.
 *
 * **Labels are sentence case**, like the app panels above them in the sidebar.
 * The two registries meet at a section boundary, and Title Case on one side of
 * it was the only thing that made the seam visible.
 */

import type { LucideIcon } from "lucide-react";
import { Server, Code, Network, Activity, Database, Radio, Gauge } from "lucide-react";
import type { EngineSettingsCategory } from "@/types";

export interface EngineSettingsCategoryMeta {
	id: EngineSettingsCategory;
	label: string;
	/** Shown under the category title in the settings view header. */
	description: string;
	icon: LucideIcon;
}

export const ENGINE_SETTINGS_CATEGORIES: readonly EngineSettingsCategoryMeta[] = [
	{
		id: "general_engine",
		// Not "General & Engine": it sits under a heading already reading
		// "Engine Settings", so "& Engine" was noise, and it put a second
		// "General" in the same sidebar as the app panel of that name.
		label: "Core",
		description:
			"The engine's base capacity, threading model and storage internals - the settings a run is built on",
		icon: Server,
	},
	{
		id: "network_performance",
		label: "Network & connectivity",
		// Widened by #703, which moved the request transport defaults in and
		// the OAuth renewal watchdog out: the shelf is the wire itself, not
		// only the throughput knobs it used to hold.
		description:
			"The wire itself: what a new request starts with, how many transfers a worker keeps open, and how long a name resolution is reused",
		icon: Network,
	},
	{
		id: "services",
		// The Dock's word for this group, and its icon - a user managing an
		// inbox or a mock server looks for the name the drawer gave it.
		label: "Services",
		description:
			"Limits for the long-lived surfaces: streaming requests, webhook inboxes, mock servers and OAuth issuers",
		icon: Radio,
	},
	{
		id: "observability",
		label: "Observability",
		description:
			"Server monitoring, per-phase latency measurement, and the live metrics that feed the dashboard's charts",
		icon: Activity,
	},
	{
		id: "data_retention",
		label: "Data & retention",
		description:
			"What a run stores and for how long: capture and truncation budgets, and the run retention limits",
		icon: Database,
	},
	{
		id: "limits",
		label: "Limits",
		// Late in the order on purpose (#586's rule is likelihood of visit):
		// nobody browses here. Every entry is arrived at from a rejection
		// message that names the setting, so search is the way in.
		description:
			"The sizes and counts a run or a collection may not exceed - the ceilings that reject an oversized input rather than truncate it",
		icon: Gauge,
	},
	{
		id: "scripting_sandbox",
		label: "Scripting environment",
		description: "Configuration for the QuickJS sandbox execution, limits, and debugging",
		icon: Code,
	},
];

/** Look up an engine category (undefined for client categories). */
export function getEngineCategory(category: string | null): EngineSettingsCategoryMeta | undefined {
	return category ? ENGINE_SETTINGS_CATEGORIES.find((c) => c.id === category) : undefined;
}

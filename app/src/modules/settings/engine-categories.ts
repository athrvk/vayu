/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The seven engine settings categories, declared once and in sidebar order, mirroring
 * `app-panels.ts` on the client side. One array is the single label per category (for the sidebar
 * tree's label and icon and the main view's title and description) and the written-down order.
 *
 * **Order is by likelihood of visit** (#586), not by how the engine seeds them.
 *
 * **Labels are sentence case**, like the app panels above them in the sidebar: the two registries
 * meet at a section boundary, and Title Case on one side would make the seam visible.
 */

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { Server, Code, Network, Activity, Database, Radio, Gauge } from "lucide-react";
import { ICON_MOTION, type IconMotion } from "@/components/ui";
import type { EngineSettingsCategory } from "@/types";
import { ClientCertificatesCard } from "./main/panels/ClientCertificatesCard";
import { ConnectionTestCard } from "./main/panels/ConnectionTestCard";

export interface EngineSettingsCategoryMeta {
	id: EngineSettingsCategory;
	label: string;
	/** Shown under the category title in the settings view header. */
	description: string;
	icon: LucideIcon;
	/**
	 * The named motion this category's glyph plays on hover or focus of its sidebar row: the field
	 * `AppSettingsPanel` carries, so `categoryMeta` reads one shape from either registry.
	 */
	motion?: IconMotion;
	/**
	 * Cards rendered above this category's config entries, in order, for engine surfaces that are
	 * not config entries: a registry with its own CRUD routes (#707), a diagnostic that sends
	 * rather than stores (#708). `GET /config` describes neither, so the generic entry renderer
	 * cannot draw them.
	 *
	 * Declared here, not branched on in `SettingsMain`, for the reason `app-panels.ts` exists: the
	 * view looks components up rather than carry a list of categories it treats specially. They
	 * save on their own (the Save bar belongs to the config entries), the split `CookiesCard` has
	 * inside the General panel.
	 */
	Cards?: readonly ComponentType[];
}

export const ENGINE_SETTINGS_CATEGORIES: readonly EngineSettingsCategoryMeta[] = [
	{
		id: "general_engine",
		// Not "General & Engine": under a heading already reading "Engine Settings", "& Engine" is
		// noise, and it would put a second "General" in the sidebar beside the app panel of that
		// name.
		label: "Core",
		description:
			"Base capacity, threading model and storage internals of Vayu's engine - the settings a run is built on",
		icon: Server,
		motion: ICON_MOTION.press,
	},
	{
		id: "network_performance",
		label: "Network & connectivity",
		// Widened by #703, which moved the request transport defaults in and
		// the OAuth renewal watchdog out: the shelf is the wire itself, not
		// only the throughput knobs.
		description:
			"The wire itself: what a new request starts with, how many transfers a worker keeps open, and how long a name resolution is reused",
		icon: Network,
		motion: ICON_MOTION.pulse,
		// The client-certificate registry (#707) and the connection test (#708) live here, not in a
		// category of their own: they are how a request leaves this machine, beside the proxy and
		// trust settings. The test is the last of the two, and above the entries, as it is used
		// *after* changing one of them.
		Cards: [ClientCertificatesCard, ConnectionTestCard],
	},
	{
		id: "services",
		// The Dock's word for this group, and its icon - a user managing an
		// inbox or a mock server looks for the name the drawer gave it.
		label: "Services",
		description:
			"Limits for the long-lived surfaces: streaming requests, webhook inboxes, mock servers and OAuth issuers",
		icon: Radio,
		motion: ICON_MOTION.waves,
	},
	{
		id: "observability",
		label: "Observability",
		description:
			"Server monitoring, per-phase latency measurement, and the live metrics that feed the dashboard's charts, and the log level for both log files",
		icon: Activity,
		motion: ICON_MOTION.trace,
	},
	{
		id: "data_retention",
		label: "Data & retention",
		description:
			"What a run stores and for how long: capture and truncation budgets, and the run retention limits",
		icon: Database,
		motion: ICON_MOTION.stack,
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
		motion: ICON_MOTION.sweep,
	},
	{
		id: "scripting_sandbox",
		label: "Scripting environment",
		description: "Configuration for the QuickJS sandbox execution, limits, and debugging",
		icon: Code,
		motion: ICON_MOTION.part,
	},
];

/** Look up an engine category (undefined for client categories). */
export function getEngineCategory(category: string | null): EngineSettingsCategoryMeta | undefined {
	return category ? ENGINE_SETTINGS_CATEGORIES.find((c) => c.id === category) : undefined;
}

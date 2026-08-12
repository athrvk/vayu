/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LoadTestingPanel
 *
 * The ceilings the load-test dialog offers. These are *this app's* policy, not
 * the engine's: the engine range-checks a run config too, but those bounds are
 * crash guards (a negative `concurrency` is an eager pre-allocation of ~1.8e19
 * curl handles), so they sit far above anything a dialog should offer and are
 * not settings. What was left was a shipped default of 1000 connections that a
 * user on real hardware had no way to raise.
 *
 * Each field here is clamped to the engine's guard on the way into the store,
 * so no value set on this screen can compose a run the engine will reject.
 * Client-side only (localStorage-backed); read by the load dialog through
 * `resolveLoadTestLimits`.
 */

import { Gauge, RotateCcw } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { useClientSettingsStore } from "@/stores";
import {
	DEFAULT_LOAD_TEST_CEILINGS,
	LOAD_TEST_CEILING_BOUNDS,
	type LoadTestCeilingKey,
} from "@/constants/load-test";
import { appSetting, type AppSettingDescriptor } from "../app-settings";
import { NumberSettingRow } from "./SettingControls";

interface CeilingField {
	key: LoadTestCeilingKey;
	/**
	 * The catalogue entry that names this row: it carries both the label the
	 * row prints and the `data-setting-anchor` a search result reveals, so the
	 * two cannot be filled in separately - see `app-settings.ts`.
	 */
	setting: AppSettingDescriptor;
	unit?: string;
	description: string;
}

/**
 * Four ceilings, not six: ramp duration follows the duration ceiling and ramp
 * start follows the connection ceiling, because each pair is the same physical
 * quantity (see `resolveLoadTestLimits`).
 */
const FIELDS: readonly CeilingField[] = [
	{
		key: "concurrency",
		setting: appSetting("load-max-connections"),
		description:
			"Upper bound on the Connections field, and on where a ramp may start or finish. The engine pre-allocates connections per worker before any traffic flows, so this is the setting that costs memory up front.",
	},
	{
		key: "rps",
		setting: appSetting("load-max-rate"),
		unit: "req/s",
		description:
			"Upper bound on the Target rate field for Constant RPS runs. What a single desktop engine can actually reach depends on the target and your network long before this does.",
	},
	{
		key: "durationSeconds",
		setting: appSetting("load-max-duration"),
		unit: "sec",
		description:
			"Upper bound on both Duration and Ramp duration. The default of one hour is a session; the ceiling of one day is the engine's own per-transfer limit.",
	},
	{
		key: "iterations",
		setting: appSetting("load-max-requests"),
		description: "Upper bound on the Requests field for Fixed Iterations runs.",
	},
];

export default function LoadTestingPanel() {
	const ceilings = useClientSettingsStore((s) => s.loadTestCeilings);
	const setCeilings = useClientSettingsStore((s) => s.setLoadTestCeilings);

	const isDefault = FIELDS.every((f) => ceilings[f.key] === DEFAULT_LOAD_TEST_CEILINGS[f.key]);

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-4">
					<div>
						<div className="flex items-center gap-2">
							<Gauge className="w-5 h-5 text-muted-foreground" />
							<CardTitle className="text-base">Load test ceilings</CardTitle>
						</div>
						<CardDescription className="mt-1">
							The largest value each field in the Run a load test dialog will offer.
							Raising one does not change any run you have already configured - it
							only widens what you can ask for. The engine enforces its own limits
							regardless, and no value here can exceed them.
						</CardDescription>
					</div>
					{!isDefault && (
						<Button
							variant="ghost"
							size="sm"
							className="shrink-0 text-xs h-7 px-2"
							onClick={() => setCeilings(DEFAULT_LOAD_TEST_CEILINGS)}
						>
							<RotateCcw className="w-3.5 h-3.5 mr-1.5" />
							{/* "all", because each row now carries its own Reset
							    beside its Default line. */}
							Reset all
						</Button>
					)}
				</div>
			</CardHeader>
			<CardContent className="space-y-5">
				{FIELDS.map((field) => {
					const bounds = LOAD_TEST_CEILING_BOUNDS[field.key];
					return (
						<NumberSettingRow
							key={field.key}
							anchor={field.setting.anchor}
							label={field.setting.label}
							description={field.description}
							value={String(ceilings[field.key])}
							// Applies live: the next load dialog reads the store, so
							// there is nothing to save and nothing to wait for.
							commit="change"
							onCommit={(next) => setCeilings({ [field.key]: parseInt(next, 10) })}
							unit={field.unit}
							min={String(bounds.MIN)}
							max={String(bounds.MAX)}
							rangeHint={`${bounds.MIN.toLocaleString()} - ${bounds.MAX.toLocaleString()}`}
							defaultValue={String(DEFAULT_LOAD_TEST_CEILINGS[field.key])}
							defaultDisplay={DEFAULT_LOAD_TEST_CEILINGS[field.key].toLocaleString()}
							onResetToDefault={() =>
								setCeilings({ [field.key]: DEFAULT_LOAD_TEST_CEILINGS[field.key] })
							}
						/>
					);
				})}
			</CardContent>
		</Card>
	);
}

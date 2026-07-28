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
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
} from "@/components/ui";
import { useClientSettingsStore } from "@/stores";
import {
	DEFAULT_LOAD_TEST_CEILINGS,
	LOAD_TEST_CEILING_BOUNDS,
	type LoadTestCeilingKey,
} from "@/constants/load-test";

interface CeilingField {
	key: LoadTestCeilingKey;
	label: string;
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
		label: "Max connections",
		description:
			"Upper bound on the Connections field, and on where a ramp may start or finish. The engine pre-allocates connections per worker before any traffic flows, so this is the setting that costs memory up front.",
	},
	{
		key: "rps",
		label: "Max target rate",
		unit: "req/s",
		description:
			"Upper bound on the Target rate field for Constant RPS runs. What a single desktop engine can actually reach depends on the target and your network long before this does.",
	},
	{
		key: "durationSeconds",
		label: "Max duration",
		unit: "sec",
		description:
			"Upper bound on both Duration and Ramp duration. The default of one hour is a session; the ceiling of one day is the engine's own per-transfer limit.",
	},
	{
		key: "iterations",
		label: "Max requests",
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
							Reset
						</Button>
					)}
				</div>
			</CardHeader>
			<CardContent className="space-y-5">
				{FIELDS.map((field) => {
					const bounds = LOAD_TEST_CEILING_BOUNDS[field.key];
					const id = `load-ceiling-${field.key}`;
					return (
						<div key={field.key} className="space-y-1.5">
							<Label htmlFor={id} className="text-sm font-medium">
								{field.label}
							</Label>
							<div className="flex items-center gap-2">
								<div className="relative">
									<Input
										id={id}
										type="number"
										inputMode="numeric"
										className={
											field.unit ? "max-w-[10rem] pr-12" : "max-w-[10rem]"
										}
										value={ceilings[field.key]}
										min={bounds.MIN}
										max={bounds.MAX}
										onChange={(e) => {
											const n = parseInt(e.target.value, 10);
											// An emptied field parses to NaN. The store
											// clamps it to the floor rather than storing a
											// NaN that would make every dialog range
											// nonsense.
											setCeilings({ [field.key]: n });
										}}
									/>
									{field.unit && (
										<span
											className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
											aria-hidden="true"
										>
											{field.unit}
										</span>
									)}
								</div>
								<span className="text-xs text-muted-foreground whitespace-nowrap">
									{bounds.MIN.toLocaleString()} - {bounds.MAX.toLocaleString()}
								</span>
							</div>
							<p className="text-xs text-muted-foreground">{field.description}</p>
							{ceilings[field.key] !== DEFAULT_LOAD_TEST_CEILINGS[field.key] && (
								<p className="text-xs text-muted-foreground">
									Default:{" "}
									{DEFAULT_LOAD_TEST_CEILINGS[field.key].toLocaleString()}
								</p>
							)}
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
}

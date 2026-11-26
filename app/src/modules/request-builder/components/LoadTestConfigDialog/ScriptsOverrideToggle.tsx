/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { ToggleGroup, ToggleGroupItem } from "@/components/ui";
import type { ScriptsOverride } from "./buildLoadTestConfig";

interface ScriptsOverrideToggleProps {
	value: ScriptsOverride;
	onChange: (value: ScriptsOverride) => void;
}

/**
 * The `elements.scripts` run override (#1594): `RunCollectionDialog`'s Scripts toggle, the same
 * three values. No Timers control: the engine does apply `elements.timers` here
 * (`load_strategy.cpp`'s `step.before` / `step.between`), but a single request's only accepted
 * timer is its own `timer.think`, and this dialog has no UI for it.
 */
export function ScriptsOverrideToggle({ value, onChange }: ScriptsOverrideToggleProps) {
	return (
		<div className="flex items-center justify-between gap-4">
			<span className="block text-sm font-medium leading-snug">
				Scripts
				<span className="block text-xs font-normal text-muted-foreground">
					As marked runs a script inline only where its own element says to; the other two
					override every script this run. Tests in a post-request script run on a sample
					unless All inline.
				</span>
			</span>
			<ToggleGroup
				size="sm"
				aria-label="Scripts"
				value={value}
				onValueChange={(next) => {
					// Radix emits "" when the active segment is clicked again; a choice is required
					// here.
					if (next === "asMarked" || next === "allInline" || next === "allDeferred") {
						onChange(next);
					}
				}}
			>
				<ToggleGroupItem value="asMarked">As marked</ToggleGroupItem>
				<ToggleGroupItem value="allInline">All inline</ToggleGroupItem>
				<ToggleGroupItem value="allDeferred">All deferred</ToggleGroupItem>
			</ToggleGroup>
		</div>
	);
}

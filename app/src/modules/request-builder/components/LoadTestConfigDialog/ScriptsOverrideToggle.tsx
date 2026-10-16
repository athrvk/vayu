/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Label, ToggleGroup, ToggleGroupItem } from "@/components/ui";
import type { ScriptsOverride } from "./buildLoadTestConfig";

interface ScriptsOverrideToggleProps {
	value: ScriptsOverride;
	onChange: (value: ScriptsOverride) => void;
}

/**
 * The `elements.scripts` run override (issue #1594), the same control and the
 * same three values `RunCollectionDialog`'s Scripts toggle offers. No Timers
 * control here, unlike that dialog - not because the engine ignores
 * `elements.timers` on this path (it applies it the same way,
 * `load_strategy.cpp`'s `step.before` / `step.between` contexts), but because
 * this dialog offers nothing to override it with yet: a single request's own
 * `timer.think` is the only timer kind `requestElements` accepts, and there is
 * no UI here for it at all, marked or not.
 */
export function ScriptsOverrideToggle({ value, onChange }: ScriptsOverrideToggleProps) {
	return (
		<div className="flex items-center justify-between gap-4">
			<Label className="leading-snug">
				Scripts
				<span className="block text-xs font-normal text-muted-foreground">
					As marked runs a script inline only where its own element says to; the other two
					override every script this run. Tests in a post-request script run on a sample
					unless All inline.
				</span>
			</Label>
			<ToggleGroup
				size="sm"
				aria-label="Scripts"
				value={value}
				onValueChange={(next) => {
					// Radix emits "" when the active segment is clicked again; a choice
					// is not optional here.
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

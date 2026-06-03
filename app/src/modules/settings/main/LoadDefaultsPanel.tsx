/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Load Test Defaults Panel
 *
 * Client-side, app-level defaults applied to load-test runs. These are not
 * engine configs — they are injected into the /run payload when the per-run
 * config doesn't specify the corresponding value (per-run always wins).
 */

import { useState } from "react";
import { Gauge } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
} from "@/components/ui";
import { useSettingsStore } from "@/stores";

export default function LoadDefaultsPanel() {
	const { maxInFlight, setMaxInFlight } = useSettingsStore();

	// Local draft so the field can be cleared/edited without committing on every
	// keystroke. Initialized once from the persisted value; this panel is the
	// only mutator of `maxInFlight`, so no external-sync effect is needed.
	const [draft, setDraft] = useState<string>(maxInFlight != null ? String(maxInFlight) : "");

	const commit = (raw: string) => {
		const trimmed = raw.trim();
		const parsed = Number.parseInt(trimmed, 10);
		if (trimmed !== "" && Number.isFinite(parsed) && parsed > 0) {
			setMaxInFlight(parsed);
			setDraft(String(parsed));
		} else {
			// Blank or invalid input falls back to auto.
			setMaxInFlight(null);
			setDraft("");
		}
	};

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Header */}
			<div className="border-b border-border px-6 py-4 shrink-0">
				<div>
					<h1 className="text-xl font-semibold">Load Test Defaults</h1>
					<p className="text-sm text-muted-foreground mt-1">
						App-level defaults applied to new load-test runs
					</p>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-auto p-6">
				<div className="grid gap-6 max-w-3xl">
					<Card>
						<CardHeader className="pb-3">
							<div className="flex items-center gap-2">
								<Gauge className="w-5 h-5 text-muted-foreground" />
								<CardTitle className="text-base">Max in-flight requests</CardTitle>
							</div>
							<CardDescription>
								Hard cap on concurrent in-flight requests. Leave blank to
								auto-derive from your RPS or concurrency setting. Raise it if your
								generator has headroom; in ConstantRps mode, lowering it causes
								drops sooner.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="space-y-2">
								<Label htmlFor="max-in-flight" className="text-sm">
									Default value
								</Label>
								<Input
									id="max-in-flight"
									type="number"
									min={1}
									step={1}
									inputMode="numeric"
									placeholder="Auto"
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
									onBlur={(e) => commit(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											commit((e.target as HTMLInputElement).value);
										}
									}}
									className="max-w-xs"
								/>
								<p className="text-xs text-muted-foreground">
									{maxInFlight != null
										? `Applied as the default unless a run sets its own value.`
										: `Auto — the engine derives a per-strategy default.`}
								</p>
							</div>
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}

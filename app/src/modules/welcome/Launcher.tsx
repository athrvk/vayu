/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Launcher — the populated welcome state.
 *
 * Reached by pressing "+", which means "start something new" — so actions lead
 * and nothing here repeats what the sidebar already shows. No branding: the app
 * is open and the logo is in the title bar.
 */

import { Download, Plus, Database, Gauge } from "lucide-react";
import type { Run } from "@/types";
import { ActionTile } from "./components/ActionTile";
import { FooterLinks } from "./components/FooterLinks";
import { RecentRuns } from "./components/RecentRuns";

interface LauncherProps {
	runs: Run[];
	collectionCount: number;
	onImport: () => void;
	onNewRequest: () => void;
	onLoadTest: () => void;
	onVariables: () => void;
}

function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function Launcher({
	runs,
	collectionCount,
	onImport,
	onNewRequest,
	onLoadTest,
	onVariables,
}: LauncherProps) {
	return (
		<div className="flex flex-col gap-8">
			<section>
				<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
					Start
				</p>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					<ActionTile icon={Plus} label="New request" onClick={onNewRequest} />
					<ActionTile icon={Download} label="Import" onClick={onImport} />
					<ActionTile icon={Gauge} label="Load test" onClick={onLoadTest} />
					<ActionTile icon={Database} label="Variables" onClick={onVariables} />
				</div>
			</section>

			<RecentRuns runs={runs} />

			<div className="flex flex-col gap-3">
				<p className="text-[12px] font-mono tabular-nums text-muted-foreground">
					{plural(collectionCount, "collection")} · {plural(runs.length, "run")}
				</p>
				<FooterLinks />
			</div>
		</div>
	);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The populated welcome state, reached by "+" ("start something new"): actions lead, nothing
 * repeats what the sidebar shows, and no branding, since the app is open and the logo is in the
 * title bar.
 */

// `Braces` is the app-wide mark for variables: the note in `constants/drawer-views.ts` says why,
// and why not `Database`.
import { Download, Plus, Braces, History, Radio, Search } from "lucide-react";
import { Eyebrow } from "@/components/ui";
import type { Run } from "@/types";
import { pluralize } from "@/modules/dashboard/utils/format";
import { ActionTile } from "./components/ActionTile";
import { DemoApiTile } from "./components/DemoApiTile";
import { FooterLinks } from "./components/FooterLinks";
import { RecentRuns } from "./components/RecentRuns";
import { WELCOME_COLUMN } from "./welcome-column";

interface LauncherProps {
	runs: Run[];
	collectionCount: number;
	onImport: () => void;
	onNewRequest: () => void;
	onOpenDemo: () => void;
	onSearch: () => void;
	onHistory: () => void;
	onVariables: () => void;
	onServices: () => void;
}

export function Launcher({
	runs,
	collectionCount,
	onImport,
	onNewRequest,
	onOpenDemo,
	onSearch,
	onHistory,
	onVariables,
	onServices,
}: LauncherProps) {
	return (
		// A centred column (WELCOME_COLUMN), not the tab's full width. `enter-fade`: this replaces
		// `LauncherSkeleton` on mount, the same swap `FirstRunWelcome` fades in for.
		<div className={`enter-fade flex flex-col gap-8 ${WELCOME_COLUMN}`}>
			{/* The tab's `h1`, named as the tab is (#3498). Hidden, because the
			    populated screen is a launcher with no title of its own to draw;
			    the first-run screen's visible "Vayu" is the same heading. */}
			<h1 className="sr-only">Vayu</h1>
			<section className="flex flex-col gap-2">
				<Eyebrow>Start</Eyebrow>
				{/* Six columns since Search joined the row: the tiles are
				    equal-weight starting points, and a grid narrower than the
				    count would strand one on a line of its own. */}
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
					<ActionTile icon={Plus} label="New request" onClick={onNewRequest} />
					{/*
					 * The command palette's visible half: the chord alone is undiscoverable, and
					 * this grid is where the app teaches its own surfaces.
					 */}
					<ActionTile icon={Search} label="Search" onClick={onSearch} />
					<ActionTile icon={Download} label="Import" onClick={onImport} />
					<ActionTile icon={History} label="History" onClick={onHistory} />
					<ActionTile icon={Braces} label="Variables" onClick={onVariables} />
					{/* The local services - the webhook inbox, the OAuth mock
					    issuer. Like History, this tile activates a drawer view
					    rather than opening a tab: a tile that teaches where
					    a whole family of features lives outlives one that opens
					    a single tab (issue #502). */}
					<ActionTile icon={Radio} label="Services" onClick={onServices} />
				</div>
				{/*
				 * Its own row, not a seventh grid cell (#1694): the six tiles are icon-and-label
				 * only, with no room for "press this chord to send it". Gone once a run exists,
				 * which answers the question this row asks, so it needs no dismiss of its own.
				 */}
				{runs.length === 0 && <DemoApiTile onClick={onOpenDemo} />}
			</section>

			<RecentRuns runs={runs} />

			<div className="flex flex-col gap-3">
				<p className="text-xs font-mono tabular-nums text-muted-foreground">
					{collectionCount} {pluralize(collectionCount, "collection")} · {runs.length}{" "}
					{pluralize(runs.length, "run")}
				</p>
				<FooterLinks />
			</div>
		</div>
	);
}

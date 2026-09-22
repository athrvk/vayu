/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Launcher - the populated welcome state.
 *
 * Reached by pressing "+", which means "start something new" - so actions lead
 * and nothing here repeats what the sidebar already shows. No branding: the app
 * is open and the logo is in the title bar.
 */

// `Braces` is the app-wide mark for variables - see the note in
// `components/layout/Dock.tsx`. It was `Database` here, which reads as stored
// records rather than `{{name}}` substitutions.
import { Download, Plus, Braces, History, Radio, Search } from "lucide-react";
import { Eyebrow } from "@/components/ui";
import type { Run } from "@/types";
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

function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
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
		// A centred column, not the full width of the tab - see WELCOME_COLUMN.
		// `enter-fade`: this replaces `LauncherSkeleton` on mount, the same plain
		// conditional-swap shape `FirstRunWelcome` fades in for (see its comment).
		<div className={`enter-fade flex flex-col gap-8 ${WELCOME_COLUMN}`}>
			<section className="flex flex-col gap-2">
				<Eyebrow>Start</Eyebrow>
				{/* Six columns since Search joined the row: the tiles are
				    equal-weight starting points, and a grid narrower than the
				    count would strand one on a line of its own. */}
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
					<ActionTile icon={Plus} label="New request" onClick={onNewRequest} />
					{/*
					 * The command palette's visible half. The chord alone is
					 * undiscoverable - nobody presses ⌘K in an app they have not
					 * been told has a palette - and this grid is where the app
					 * teaches its own surfaces.
					 */}
					<ActionTile icon={Search} label="Search" onClick={onSearch} />
					<ActionTile icon={Download} label="Import" onClick={onImport} />
					<ActionTile icon={History} label="History" onClick={onHistory} />
					<ActionTile icon={Braces} label="Variables" onClick={onVariables} />
					{/* The local services - the webhook inbox, the OAuth mock
					    issuer. Like History, this tile activates a drawer view
					    rather than opening a tab: the inbox used to be reachable
					    from here and nowhere else, and a tile that teaches where
					    a whole family of features lives outlives one that opens
					    a single tab (issue #502). */}
					<ActionTile icon={Radio} label="Services" onClick={onServices} />
				</div>
				{/*
				 * Its own row, not a seventh grid cell (issue #1694): the grid's
				 * six tiles are icon-and-label only, with no room for "press this
				 * chord to send it". Gone the moment a run exists - once one
				 * does, the app has already answered the question this row asks,
				 * so it needs no dismiss of its own.
				 */}
				{runs.length === 0 && <DemoApiTile onClick={onOpenDemo} />}
			</section>

			<RecentRuns runs={runs} />

			<div className="flex flex-col gap-3">
				<p className="text-xs font-mono tabular-nums text-muted-foreground">
					{plural(collectionCount, "collection")} · {plural(runs.length, "run")}
				</p>
				<FooterLinks />
			</div>
		</div>
	);
}

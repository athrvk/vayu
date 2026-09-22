/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Info, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	useEngineStore,
	useLayoutStore,
	useSaveStore,
	useTabsStore,
	// Aliased: `EngineStatus` is the component below, and the type is what it
	// switches on.
	type EngineStatus as EngineConnectionStatus,
} from "@/stores";
import { ICON_MOTION, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { useRunningServiceCount } from "@/modules/services";
import { useEngineRestart } from "@/hooks/useEngineRestart";
import { ResponsePositionButton } from "./ResponsePositionButton";

/**
 * What each engine state is called in the strip.
 *
 * "Disconnected" stays the word for `unreachable` - it is what the state has
 * always been called here and in the docs, and the new state is the one that
 * needed a name of its own.
 */
const ENGINE_STATUS_LABEL: Record<EngineConnectionStatus, string> = {
	starting: "Starting…",
	connected: "Connected",
	unreachable: "Disconnected",
};

/**
 * The connection light - and, when it is out, why.
 *
 * `engineError` is written on every failed health poll (`queries/health.ts`)
 * and was read by nothing: the strip said "Disconnected" whether the engine had
 * refused the connection, timed out, or died mid-request, and the only place
 * the difference existed was devtools. It rides a tooltip rather than the strip
 * because the text is whatever the transport produced and can run long, and the
 * strip is a 2rem ambient row - the same reason `save-store`'s failure reason
 * became a toast rather than a line here.
 *
 * The trigger is focusable, so the reason is reachable by keyboard and not only
 * by hover, and the icon exists to say there is something to hover at all.
 *
 * Only `unreachable` gets that affordance. The window paints while the engine is
 * still starting (#1144), so the first seconds of every launch are spent not
 * connected - and rendering a red flag and a transport error there described a
 * failure that had not happened (#1164). "Starting…" is a state of its own,
 * quiet by design, and the store turns it into `unreachable` on its own budget
 * so an engine that never comes up still ends up saying why.
 */
function EngineStatus() {
	const engineStatus = useEngineStore((s) => s.engineStatus);
	const engineError = useEngineStore((s) => s.engineError);

	/*
	 * `status-success-text`: not the general `success-text`, and not the bare
	 * `status-success`. A connection light is precisely what design-system.md
	 * means by "Run, connection, and test status", so it belongs to the
	 * `--status-*` family - the family a reader greps to find every status
	 * surface. The comment this replaces rejected the *bare* token, which is the
	 * right rejection and the wrong conclusion: as 12px text `status-success`
	 * measures 2.21:1 on --panel (design-system.md's own figure, reproduced), and
	 * the family's answer to that is its `-text` pair, not a different family.
	 *
	 * Measured on --panel, the Dock's own surface, in both themes: 5.43:1 light
	 * (142 72% 27%) and 9.61:1 dark (142 60% 55%), so the dot - which inherits
	 * the colour through bg-current - clears the 3:1 non-text bar too. The pair
	 * is byte-identical to --success-text in both modes, so the swap moved no
	 * pixel; it moved the token into the family that names this indicator.
	 *
	 * `starting` and `unreachable` stay on --muted-foreground, which is what the
	 * doc prescribes for a pending state (there is no --status-pending).
	 */
	const className = cn(
		"flex items-center gap-1 text-xs",
		engineStatus === "connected" ? "text-status-success-text" : "text-muted-foreground"
	);
	const label = (
		<>
			<span className="w-1.5 h-1.5 rounded-full bg-current" />
			{ENGINE_STATUS_LABEL[engineStatus]}
		</>
	);

	if (engineStatus !== "unreachable" || !engineError) {
		return <span className={className}>{label}</span>;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					// eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- TooltipTrigger (Radix) wires focus and blur to reveal and dismiss this tooltip, which is the only keyboard path to the engine error text
					tabIndex={0}
					className={cn(
						className,
						"cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					)}
				>
					{label}
					<Info className="size-icon-sm" aria-hidden="true" />
				</span>
			</TooltipTrigger>
			{/* Wraps rather than truncates: an engine message names a port, a path
			    or a TLS failure, and the tail is the part that identifies it. */}
			<TooltipContent side="top">
				<p className="max-w-64 whitespace-normal break-words">{engineError}</p>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The app's own build version, with the running engine's worker-thread count
 * on hover (issue #1508) - the one place that number was computed and never
 * read anywhere in the app.
 *
 * `workers` is `null` until the first health poll answers, which is also true
 * of a disconnected engine that has never connected this session; either way
 * there is nothing to report yet, so the version renders as a plain span with
 * no hover affordance, matching `EngineStatus`'s "nothing to hover for, so
 * nothing pretends there is" rule above.
 */
function EngineVersion() {
	const workers = useEngineStore((s) => s.workers);
	const label = <span className="text-xs text-muted-foreground">v{__VAYU_VERSION__}</span>;

	if (workers === null) {
		return label;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					// eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- TooltipTrigger (Radix) wires focus and blur to reveal and dismiss this tooltip, which is the only keyboard path to the worker count
					tabIndex={0}
					className="cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					{label}
				</span>
			</TooltipTrigger>
			<TooltipContent side="top">
				<p>{workers === 1 ? "1 worker thread" : `${workers} worker threads`}</p>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * A saved setting the running engine has not picked up yet.
 *
 * Every other setting in the app confirms itself: the value is written, the
 * thing it governs changes. The restart-required ones cannot - the engine keeps
 * serving the old value until it is relaunched - and until now nothing said so
 * outside the Settings screen, which is exactly where the user is *not* once
 * they have moved on. So the Dock carries it, beside the connection light that
 * already answers "what is the engine doing".
 *
 * What it tracks, stated plainly: settings saved from this app since it
 * connected that the engine marks `requiresRestart` (`engine-store`, written by
 * `SettingsMain`). Not a comparison against the engine's running values - it
 * does not report those, so any such claim would be inferred rather than known.
 * The honest consequence is that this cannot survive a reload of the renderer,
 * and it says "saved" rather than "in effect".
 */
function PendingRestart() {
	const pendingRestart = useEngineStore((s) => s.pendingRestart);
	// The subtree stops here on the ordinary path, so the machinery behind the
	// action - the restart itself, and the cache invalidation that follows it -
	// is only mounted while there is a restart to offer.
	return pendingRestart ? <PendingRestartButton /> : null;
}

/**
 * A local service is listening somewhere - the one thing that was invisible
 * outside the surface that started it (issue #502).
 *
 * A webhook inbox recorded a request whether or not its tab was open, and an
 * OAuth issuer had no app surface at all, so "is something still running?" was
 * a question the app could not answer anywhere. It sits beside the connection
 * light because that is this strip's ambient-status region, and because these
 * are the same kind of fact: what the engine is doing on the user's behalf.
 *
 * **Nothing renders when nothing runs** - and an engine that is not connected,
 * starting or unreachable alike, is running nothing, which
 * `useRunningServiceCount` is what decides (it holds the gate,
 * so no reader has to remember the caveat). The Dock's middle is ambient, and a
 * standing "0 services" would spend a permanent line on the ordinary case.
 * Guarded by `Dock.services.test.tsx` - rendering it unconditionally fails.
 */
function RunningServices() {
	// Reveal, never toggle: an ambient chip that says something is listening is
	// pointing *at* the drawer, so clicking it with the drawer already on
	// Services used to close the one surface that can act on them.
	const revealDrawerView = useLayoutStore((s) => s.revealDrawerView);
	const count = useRunningServiceCount();

	if (count === 0) return null;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/*
				 * A button, not a chip: knowing a listener is up is only half the
				 * need - the other half is getting to it, and the drawer is where
				 * it can be stopped or copied. A listener being up is a service's
				 * run state, so it takes `status-success-text`, the same pair the
				 * connection light above uses for the same 12px dot.
				 */}
				<button
					onClick={() => revealDrawerView("services")}
					className="enter-fade flex items-center gap-1 text-xs text-status-success-text rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<span className="w-1.5 h-1.5 rounded-full bg-current" />
					{count === 1 ? "1 service" : `${count} services`}
				</button>
			</TooltipTrigger>
			<TooltipContent side="top">
				<p>Local services are running. Open the Services sidebar.</p>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The Dock's answer to "is my edit still unsaved", once the failure toast
 * that first reported it has expired.
 *
 * `--destructive-text` for the word, not the general `-text` a status dot
 * would use: this is not an engine connection state, it is the same failed
 * class of thing a destructive action warns about. The rest of the line stays
 * `--muted-foreground` like its three siblings, so only the word that means
 * trouble is coloured.
 */
/**
 * Every line the save slot below can show, and whether that line carries the
 * `Info` glyph - `SaveError`'s, the only one of the four that does.
 *
 * One table rather than four hand-written spans, because it is read twice: once
 * to draw the live line, and once to draw the hidden twins that hold the slot's
 * width. A fifth state added to the store and not to this table would reserve
 * the wrong width, which is the one way this can go quietly wrong.
 */
const SAVE_LINES = {
	pending: { text: "Unsaved changes", hint: false },
	saving: { text: "Saving…", hint: false },
	saved: { text: "Saved", hint: false },
	error: { text: "Not saved", hint: true },
} as const;

function SaveError() {
	const message = useSaveStore((s) => s.lastErrorMessage);

	const label = <span className="text-destructive-text">{SAVE_LINES.error.text}</span>;

	if (!message) {
		return <span className="enter-fade text-xs text-muted-foreground">{label}</span>;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					// eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- TooltipTrigger (Radix) wires focus and blur to reveal and dismiss this tooltip, which is the only keyboard path to the save error text
					tabIndex={0}
					className="enter-fade flex items-center gap-1 text-xs text-muted-foreground cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					{label}
					<Info className="size-icon-sm" aria-hidden="true" />
				</span>
			</TooltipTrigger>
			<TooltipContent side="top">
				<p className="max-w-64 whitespace-normal break-words">{message}</p>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The save line, animated into a track that costs nothing while idle.
 *
 * **Why this animates rather than reserving.** The four lines used to be four
 * `{status === "x" && ...}` children of the ambient group, which is centred in
 * the strip by two equal `flex-1` gutters - so the group's own width decides
 * where it starts, and every item in it moves when that width changes. One
 * edit walks the store through `pending` -> `saving` -> `saved` -> `idle`,
 * four different widths in a couple of seconds, and each step slid the
 * connection light one way and the version string the other, by half the
 * difference. It is the ambient row of the whole app, on screen behind every
 * surface in it, and it twitched on every keystroke sequence the user typed
 * anywhere. An earlier fix reserved the widest line's width permanently (the
 * `MARK_SLOT` mechanism in `ui/tabs.tsx`), which stopped the twitch but left a
 * standing gap between the connection light and the version on every screen,
 * for the far more common case of nothing needing saving at all.
 *
 * **The mechanism is `MARK_TRACK`'s** (`ui/tabs.tsx`): a
 * `grid-template-columns: 0fr -> 1fr` track that is genuinely zero width at
 * `idle`, and animates open to the live line's own intrinsic width otherwise -
 * `-mx-4` cancels this row's `gap-4` on both sides while the track is `0fr`,
 * the same way `MARK_TRACK` cancels a trigger's `gap-1.5`, so an idle save
 * state costs neither width nor gap. `pending` -> `saving` -> `saved` -> `idle`
 * is now a smooth grow-then-shrink instead of a jump, and `idle` at rest looks
 * exactly like the row did before any of this existed.
 */
function SaveStatusLine() {
	const status = useSaveStore((s) => s.status);
	const line = status === "idle" ? null : SAVE_LINES[status];

	return (
		<div
			data-slot="dock-save-status"
			className={cn(
				"grid overflow-hidden text-xs text-muted-foreground transition-[grid-template-columns,margin-inline] duration-150 ease-out",
				line ? "grid-cols-[1fr] mx-0" : "grid-cols-[0fr] -mx-4"
			)}
		>
			<span className="flex min-w-0 items-center justify-center">
				{/*
				 * The toast still carries the reason, first - it is the one channel
				 * every failure in the app reports through, and it has room for a
				 * message like "database is locked" that a 60-char span cannot. But
				 * it clears itself after ten seconds, and a failed save leaves the
				 * draft unsaved for as long as the engine stays down. This line is
				 * the part that outlives the toast: the same tooltip-on-hover shape
				 * `EngineStatus` uses for its own error, so the strip has one
				 * pattern for "there is a reason, hover for it" rather than two.
				 */}
				{status === "error" ? (
					<SaveError />
				) : line ? (
					// `key`, so `.enter-fade` still gets a mount to fade in on every
					// text change, independent of the track's own width animation.
					<span key={line.text} className="enter-fade whitespace-nowrap">
						{line.text}
					</span>
				) : null}
			</span>
		</div>
	);
}

function PendingRestartButton() {
	const { restart, isRestarting } = useEngineRestart();

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/*
				 * A button, not a chip with a tooltip: the restart is the point,
				 * and a status that can only be read is one more thing to carry
				 * back to Settings. Warning tokens rather than a raw amber - the
				 * `-text` variant is the pair that passes contrast at 12px, the
				 * same rule the connection light follows above.
				 *
				 * Deliberately `--warning` and not the `--status-*` family the two
				 * indicators beside it now use: this announces a pending action on
				 * a setting, not the state of a run, a connection or a service, and
				 * amber in that family means "4xx client error".
				 */}
				<button
					onClick={() => void restart()}
					disabled={isRestarting}
					className="enter-fade group flex items-center gap-1 text-xs text-warning-text rounded-sm hover:underline disabled:no-underline disabled:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<RefreshCw
						className={cn("size-icon-sm", isRestarting && "animate-spin")}
						// Not while it is already spinning: the one-shot turn would
						// fight the `animate-spin` loop that says work is happening.
						data-icon-motion={isRestarting ? undefined : ICON_MOTION.spinOnce}
						aria-hidden="true"
					/>
					{isRestarting ? "Restarting…" : "Restart pending"}
				</button>
			</TooltipTrigger>
			<TooltipContent side="top">
				<p className="max-w-64 whitespace-normal break-words">
					A saved setting needs an engine restart to take effect. Click to restart now.
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

export function Dock() {
	// The type alone, so the strip does not re-render on every tab-store write.
	const activeTabType = useTabsStore(
		(s) => s.openTabs.find((t) => t.id === s.activeTabId)?.type ?? null
	);

	// No TooltipProvider of its own. A bare nested one would reset this strip to
	// Radix's 700ms default, ignoring the app-wide delay set in main.tsx.
	return (
		<>
			{/*
			 * Height comes from --dock-height, not a bare `h-8`, because the toast
			 * viewport is `fixed` and has to offset itself above this strip - see
			 * `ui/toast.tsx`. Same value (2rem); the token is what keeps the two
			 * from drifting apart.
			 *
			 * Status in the centre, per-tab view controls on the right. #1615
			 * moved the sidebar-view switchers to `ActivityRail` and the
			 * context-bar toggle to `ContextRail`, both on a window edge the OS
			 * never covers, and left this strip status-only; #1711 amends that
			 * to admit a right-aligned cluster of controls that act on the
			 * *active tab's* view, rendered only while that tab is a request
			 * tab. The rule that survives both is the one that matters: every
			 * item here has a non-footer path (pending restart is the banner in
			 * Settings, save status opens the tab it names, the response
			 * position has its chord, its palette row and its Settings row), so
			 * the system Dock covering this strip on macOS costs a glance, never
			 * a click.
			 *
			 * The centre group stays centred in the whole strip, not in what the
			 * right cluster leaves: the two gutters are equal `flex-1` boxes and
			 * the right one holds the cluster at its end, so the connection light
			 * does not shift when a request tab comes and goes.
			 */}
			<div className="flex items-center h-[var(--dock-height)] px-2 gap-2 border-t border-border bg-panel shrink-0">
				<div className="flex-1" aria-hidden="true" />

				{/* Ambient status */}
				<div className="flex items-center justify-center gap-4">
					<EngineStatus />

					<RunningServices />

					<PendingRestart />

					{/*
					 * "Unsaved changes" is the only place in the app that says so.
					 * The tab strip deliberately has no unsaved-dot because
					 * auto-save is the safety net - but auto-save is a setting the
					 * user can turn off, and with it off nothing was ever written
					 * back and nothing said as much. `pending` was set on every
					 * edit and rendered nowhere.
					 *
					 * Unconditional, and holding its own width: see
					 * `SaveStatusLine`. Four gated spans is what slid the
					 * connection light and the version string on every edit.
					 */}
					<SaveStatusLine />

					{/*
					 * Full muted-foreground, not /50. At half opacity the version
					 * measured 2.71:1 dark and 1.94:1 light - the only element in the
					 * app failing contrast. `subtle-foreground` would not fix it
					 * either (3.63 / 3.04); it is the faintest *readable* tier, still
					 * under AA for 12px text. A version string is information, not
					 * decoration, so it gets a passing colour.
					 */}
					<EngineVersion />
				</div>

				{/* Per-tab view controls - a request tab's only, for now. */}
				<div className="flex-1 flex items-center justify-end gap-1">
					{activeTabType === "request" && <ResponsePositionButton />}
				</div>
			</div>
		</>
	);
}

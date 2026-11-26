/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Info, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { TIMING } from "@/config/timing";
import {
	selectEngineRestartOffered,
	selectKnownEngineStatus,
	useEngineStore,
	useLayoutStore,
	useSaveStore,
	useTabsStore,
	type EngineCrash,
	// Aliased: `EngineStatus` is the component below, and the type is what it
	// switches on.
	type EngineStatus as EngineConnectionStatus,
	type SaveStatus,
} from "@/stores";
import {
	ICON_MOTION,
	Tooltip,
	TooltipContent,
	TooltipHint,
	TooltipTrigger,
	TooltipValue,
} from "@/components/ui";
import { ENGINE_BASE_URL } from "@/config/network";
import { useRunningServiceCount } from "@/modules/services";
import { useEngineRestart } from "@/hooks/useEngineRestart";
import { describeEngineCrash, engineCrashOutput } from "@/lib/engine-crash";
import { BottomPanelButton } from "./BottomPanelButton";
import { ResponsePositionButton } from "./ResponsePositionButton";
import { regionProps } from "./region-focus";
import { pluralize } from "@/modules/dashboard/utils/format";

/**
 * What each engine state is called in the strip. `unreachable` keeps "Disconnected", the word the
 * docs use for it; `starting` has a name of its own.
 */
const ENGINE_STATUS_LABEL: Record<EngineConnectionStatus, string> = {
	starting: "Starting…",
	connected: "Engine connected",
	unreachable: "Engine disconnected",
};

/**
 * What the engine's process did, as the tooltip reads it: the sentence, then the
 * last of what it printed, which is usually the reason the code only points at.
 */
function EngineCrashDetail({ crash }: { crash: EngineCrash }) {
	const output = engineCrashOutput(crash);
	return (
		<>
			<span className="block">{describeEngineCrash(crash)}</span>
			{output && (
				<TooltipHint className="mt-1 block whitespace-pre-wrap break-all font-mono">
					{output}
				</TooltipHint>
			)}
		</>
	);
}

/**
 * The connection light's tooltip, or null when it has nothing to say. Connected: the engine's
 * address, which may be a fallback port (#2118) that `vayu-cli --daemon` or `VAYU_ENGINE_URL` must
 * be given. Unreachable: the main process's own sentence when it has one (written for the user),
 * then how the engine's process left (#3336), else what the transport said. Starting: quiet.
 */
function engineStatusDetail(
	status: EngineConnectionStatus,
	startFailure: string | null,
	crash: EngineCrash | null,
	engineError: string | null
): ReactNode {
	if (status === "connected") {
		return <TooltipValue hint="Engine address">{ENGINE_BASE_URL}</TooltipValue>;
	}
	if (status === "starting") return null;
	if (startFailure) return startFailure;
	if (crash) return <EngineCrashDetail crash={crash} />;
	return engineError;
}

/**
 * The connection light and, when it is out, why. The reason is `engineError`, written on every
 * failed health poll (`queries/health.ts`), so a refused connection, a timeout and a death
 * mid-request read apart. It rides a tooltip, not the strip: the transport's text can run long and
 * the strip is a 2rem ambient row (the reason `save-store`'s failure reason is a toast). The
 * trigger is focusable, so the reason is reachable by keyboard, and the icon says there is
 * something to hover. A connected engine's address rides the same trigger without the icon: it is
 * reference, not a problem to go and read.
 *
 * Only `unreachable` gets the reason. The window paints while the engine is still starting (#1144),
 * and a red flag and a transport error there report a failure that has not happened (#1164).
 * "Starting…" is quiet; the store turns it into `unreachable` on its own budget, so an engine that
 * never comes up still ends up saying why.
 *
 * A start failure the main process reports (every engine port held, #2118) offers Retry, and an
 * engine that left on its own (#3336) offers Restart and names how it left: the sentence tells the
 * user to press it, and the Dock is where they read it. The light reads `selectKnownEngineStatus`,
 * so a crash the sidecar reported turns it at once, ahead of the health refetch the push asks for
 * (#3493): "Engine connected" never stands beside the Restart a dead engine needs.
 */
function EngineStatus() {
	const engineStatus = useEngineStore(selectKnownEngineStatus);
	const engineError = useEngineStore((s) => s.engineError);
	const engineStartFailure = useEngineStore((s) => s.engineStartFailure);
	const engineCrash = useEngineStore((s) => s.engineCrash);
	const restartOffered = useEngineStore(selectEngineRestartOffered);

	/*
	 * `status-success-text`: a connection light is what design-system/accent-and-status.md means by
	 * "Run, connection, and test status", so it belongs to the `--status-*` family, the one a
	 * reader greps to find every status surface. As 12px text the bare `status-success` measures
	 * 2.21:1 on --panel (that doc's figure, reproduced), and the family's answer is its `-text`
	 * pair, not another family. On --panel, the Dock's surface: 5.43:1 light (142 72% 27%) and
	 * 9.61:1 dark (142 60% 55%), so the dot, coloured through bg-current, clears the 3:1 non-text
	 * bar too. The pair is byte-identical to --success-text in both modes; the family, not the
	 * colour, is why it is used.
	 *
	 * `starting` and `unreachable` stay on --muted-foreground, the doc's colour for a pending state
	 * (there is no --status-pending).
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

	const detail = engineStatusDetail(engineStatus, engineStartFailure, engineCrash, engineError);
	const status = detail ? (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					// eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- TooltipTrigger (Radix) wires focus and blur to reveal and dismiss this tooltip, which is the only keyboard path to the engine address and error text
					tabIndex={0}
					className={cn(
						className,
						"cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					)}
				>
					{label}
					{engineStatus === "unreachable" && (
						<Info className="size-icon-sm" aria-hidden="true" />
					)}
				</span>
			</TooltipTrigger>
			{/*
			 * Wraps rather than truncates: an engine message names a port, a path or a TLS failure,
			 * and the tail is the part that identifies it. `max-w-3xs` (16rem, Tailwind's container
			 * scale), not `max-w-64`, which rides `--spacing` and narrows the column at the Default
			 * density: this bounds a wrap width, not chrome rhythm.
			 */}
			<TooltipContent side="top">
				<p className="max-w-3xs whitespace-normal break-words">{detail}</p>
			</TooltipContent>
		</Tooltip>
	) : (
		<span className={className}>{label}</span>
	);

	if (!restartOffered) return status;

	return (
		<>
			{status}
			{engineStartFailure ? (
				<EngineRestartButton idleLabel="Retry" busyLabel="Retrying…" />
			) : (
				<EngineRestartButton idleLabel="Restart" busyLabel="Restarting…" />
			)}
		</>
	);
}

/**
 * The engine restart as a warning-toned button, shared by Retry after a start failure and the
 * pending-setting restart so the two cannot drift. Spreads the rest onto the `<button>`:
 * `PendingRestartButton` wraps it in a `TooltipTrigger asChild`, which hands it a ref and handlers.
 */
function EngineRestartButton({
	idleLabel,
	busyLabel,
	className,
	...props
}: {
	idleLabel: string;
	busyLabel: string;
} & Omit<ComponentProps<"button">, "children" | "onClick" | "disabled">) {
	const { restart, isRestarting } = useEngineRestart();

	return (
		<button
			{...props}
			onClick={() => void restart()}
			disabled={isRestarting}
			className={cn(
				"group flex items-center gap-1 text-xs text-warning-text rounded-sm hover:underline disabled:no-underline disabled:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className
			)}
		>
			<RefreshCw
				className={cn("size-icon-sm", isRestarting && "animate-spin")}
				// Not while it is already spinning: the one-shot turn would
				// fight the `animate-spin` loop that says work is happening.
				data-icon-motion={isRestarting ? undefined : ICON_MOTION.spinOnce}
				aria-hidden="true"
			/>
			{isRestarting ? busyLabel : idleLabel}
		</button>
	);
}

/**
 * The app's build version, with the running engine's worker-thread count on hover (#1508).
 * `workers` is `null` until the first health poll answers, as for an engine that has never
 * connected: with nothing to report, the version is a plain span with no hover affordance.
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
				<p>{`${workers} ${pluralize(workers, "worker thread")}`}</p>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * A saved setting the running engine has not picked up yet. A restart-required setting cannot
 * confirm itself (the engine serves the old value until relaunched), and once the user has left
 * Settings nothing else says so; the Dock carries it beside the connection light, which already
 * answers "what is the engine doing".
 *
 * It tracks settings saved from this app since it connected that the engine marks `requiresRestart`
 * (`engine-store`, written by `SettingsMain`), not the engine's running values, which the engine
 * does not report. So it does not survive a renderer reload, and it says "saved", not "in effect".
 */
function PendingRestart() {
	const pendingRestart = useEngineStore((s) => s.pendingRestart);
	// The restart and the cache invalidation after it are mounted only while there is a restart to
	// offer: the ordinary path stops here.
	return pendingRestart ? <PendingRestartButton /> : null;
}

/**
 * A local service is listening somewhere (#502). A webhook inbox records a request whether or not
 * its tab is open, and an OAuth issuer has no app surface at all. It sits beside the connection
 * light, in the strip's ambient-status region, as the same kind of fact: what the engine is doing
 * on the user's behalf.
 *
 * **Nothing renders when nothing runs**, and an engine that is not connected (starting or
 * unreachable) runs nothing; `useRunningServiceCount` holds that gate, so no reader has to remember
 * it. A standing "0 services" would spend a permanent line on the ordinary case.
 * `Dock.services.test.tsx` fails if it renders unconditionally.
 */
function RunningServices() {
	// Reveal, never toggle: the chip points *at* the drawer, and a toggle would close it when it is
	// already on Services, the one surface that can act on them.
	const revealDrawerView = useLayoutStore((s) => s.revealDrawerView);
	const count = useRunningServiceCount();

	if (count === 0) return null;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/*
				 * A button, not a chip: the drawer is where a listener can be stopped or copied. A
				 * listener being up is a service's run state, so it takes `status-success-text`,
				 * the connection light's pair for the same 12px dot.
				 */}
				<button
					onClick={() => revealDrawerView("services")}
					className="enter-fade flex items-center gap-1 text-xs text-status-success-text rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<span className="w-1.5 h-1.5 rounded-full bg-current" />
					{`${count} ${pluralize(count, "service")}`}
				</button>
			</TooltipTrigger>
			<TooltipContent side="top">
				<p>Local services are running. Open the Services sidebar.</p>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * Every line the save slot below can show, and whether it carries the `Info` glyph (only
 * `SaveError`'s does). One table, read by the live line and by `SaveError`'s word, so the two
 * cannot name a state differently.
 */
const SAVE_LINES = {
	pending: { text: "Unsaved changes", hint: false },
	saving: { text: "Saving…", hint: false },
	saved: { text: "Saved", hint: false },
	error: { text: "Not saved", hint: true },
} as const;

/**
 * The Dock's answer to "is my edit still unsaved" once the failure toast has expired.
 * `--destructive-text` for the word, not a `--status-*` pair: a failed save is not a connection
 * state but the class of thing a destructive action warns about. The rest of the line stays
 * `--muted-foreground` like the other three, so only the word meaning trouble is coloured.
 */
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
			{/* `max-w-3xs`, not `max-w-64`: the wrap-width rule at `EngineStatus`'s tooltip. */}
			<TooltipContent side="top">
				<p className="max-w-3xs whitespace-normal break-words">{message}</p>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * Holds "saving" on screen for `TIMING.SAVING_MIN_VISIBLE_MS` before "saved" replaces it, and holds
 * whatever is showing for `TIMING.SAVE_LINE_FADE_MS` past a return to `idle`, so a CSS fade has
 * something to animate against. A display concern: `save-store`'s derived `status` flips the
 * instant a save is reported or expires, and its other readers (the tests of every surface that
 * reports to it among them) need that at once.
 *
 * - A save against the local engine often lands in well under 100ms, too short to register as a
 *   state, so "Unsaved changes" would jump to "Saved" with "Saving…" gone in the same frame.
 * - `idle` has no line (`SAVE_LINES` has no entry for it), so without the hold the live text goes
 *   at once and the track's `transition-[grid-template-columns]` has nothing to shrink around: a
 *   hard cut, not a fade.
 *
 * Every other transition mirrors `status` at once. No generation counter: an effect cleanup cancels
 * a stale scheduled update whenever `status` or `displayed` changes before it fires.
 */
function useSaveStatusDisplay(status: SaveStatus): SaveStatus {
	const [displayed, setDisplayed] = useState(status);
	const savingShownAtRef = useRef<number | null>(null);

	useEffect(() => {
		if (status === "saving") savingShownAtRef.current = Date.now();
	}, [status]);

	useEffect(() => {
		if (status === displayed) return;

		if (displayed === "saving" && status === "saved") {
			const shownAt = savingShownAtRef.current;
			const elapsed = shownAt === null ? Infinity : Date.now() - shownAt;
			const remaining = Math.max(0, TIMING.SAVING_MIN_VISIBLE_MS - elapsed);
			if (remaining > 0) {
				const timer = setTimeout(() => setDisplayed(status), remaining);
				return () => clearTimeout(timer);
			}
		}

		if (status === "idle" && displayed !== "idle") {
			const timer = setTimeout(() => setDisplayed(status), TIMING.SAVE_LINE_FADE_MS);
			return () => clearTimeout(timer);
		}

		// Every other transition (idle -> pending, pending -> saving, anything -> error) has
		// nothing to hold for and mirrors `status` at once: syncing local display state to an
		// external store's value is what this effect is for.
		// eslint-disable-next-line react-hooks/set-state-in-effect -- see above
		setDisplayed(status);
	}, [status, displayed]);

	return displayed;
}

/**
 * The save line, in a track that costs nothing while idle.
 *
 * **It animates rather than reserving a width.** The ambient group is centred in the strip by two
 * equal `flex-1` gutters, so its width decides where every item in it sits. One edit walks the
 * store through `pending` -> `saving` -> `saved` -> `idle`, four widths in a couple of seconds, and
 * gated lines slide the connection light one way and the version the other by half of each
 * difference, on the row behind every surface. Reserving the widest line's width (the `MARK_SLOT`
 * mechanism in `ui/tabs.tsx`) stops that but leaves a standing gap between the light and the
 * version for the far more common case of nothing to save.
 *
 * **The mechanism is `MARK_TRACK`'s** (`ui/tabs.tsx`): a `grid-template-columns: 0fr -> 1fr` track,
 * zero width at `idle`, opening to the live line's own intrinsic width. `-ms-4` cancels the row's
 * `gap-4` before this slot while the track is `0fr`, as `MARK_TRACK` does for a trigger's
 * `gap-1.5`. One side only, not `-mx-4`: the `gap-4` after it, before `EngineVersion`, has to
 * survive, so at `idle` the row holds one gap between neighbours, never two, never zero.
 */
function SaveStatusLine() {
	const rawStatus = useSaveStore((s) => s.status);
	const status = useSaveStatusDisplay(rawStatus);
	const line = status === "idle" ? null : SAVE_LINES[status];
	// True for the `TIMING.SAVE_LINE_FADE_MS` window the hook holds `status` past the store's own
	// return to `idle`: it tells the live cell to fade rather than sit at full opacity.
	const fading = rawStatus === "idle" && status !== "idle";

	return (
		<div
			data-slot="dock-save-status"
			className={cn(
				"grid overflow-hidden text-xs text-muted-foreground transition-[grid-template-columns,margin-inline-start] duration-150 ease-out",
				line ? "grid-cols-[1fr] ms-0" : "grid-cols-[0fr] -ms-4"
			)}
		>
			<span
				className={cn(
					"flex min-w-0 items-center justify-center transition-opacity duration-200 ease-out",
					fading ? "opacity-0" : "opacity-100"
				)}
			>
				{/*
				 * The toast still carries the reason first: it is the channel every failure reports
				 * through, with room for a message like "database is locked" that a 60-char span
				 * lacks. But it clears after ten seconds, and a failed save leaves the draft
				 * unsaved while the engine stays down, so this line outlives it, with
				 * `EngineStatus`'s tooltip-on-hover shape: one pattern in the strip for "there is a
				 * reason, hover for it", not two.
				 */}
				{status === "error" ? (
					<SaveError />
				) : line ? (
					// No `key`, deliberately: `key={line.text}` remounts the span on every status
					// change and replays `.enter-fade`, which has no exit half, so the old text
					// vanishes as the new fades in, three times in one save, a flash rather than
					// motion. The track opening from `idle` already says something appeared; a text
					// change inside an open track is a plain swap.
					<span className="whitespace-nowrap">{line.text}</span>
				) : null}
			</span>
		</div>
	);
}

function PendingRestartButton() {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/*
				 * A button, not a chip with a tooltip: the restart is the point, and a status that
				 * can only be read is one more thing to carry back to Settings. Warning tokens, not
				 * a raw amber: the `-text` variant is the pair that passes contrast at 12px, the
				 * connection light's rule. Not the `--status-*` family its neighbours use: this is
				 * a pending action on a setting, not the state of a run, a connection or a service,
				 * and amber in that family means "4xx client error".
				 */}
				<EngineRestartButton
					idleLabel="Restart pending"
					busyLabel="Restarting…"
					className="enter-fade"
				/>
			</TooltipTrigger>
			{/* `max-w-3xs`, not `max-w-64`: the wrap-width rule at `EngineStatus`'s tooltip. */}
			<TooltipContent side="top">
				<p className="max-w-3xs whitespace-normal break-words">
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
			 * Height from --dock-height, not a bare `h-8`: the `fixed` toast viewport offsets
			 * itself above this strip by the same token (`ui/toast.tsx`), which keeps the two from
			 * drifting. Same value, 2rem.
			 *
			 * Status in the centre, controls on the right (#1615, #1711, #3635). Every item here
			 * has a non-footer path (pending restart is the banner in Settings, save status opens
			 * the tab it names, the response position has its chord, its palette row and its
			 * Settings row, the bottom panel its chord and its palette row), so the system Dock
			 * covering this strip on macOS costs a glance, never a click.
			 *
			 * The centre group is centred in the whole strip, not in what the right cluster leaves:
			 * the two gutters are equal `flex-1` boxes and the right one holds the cluster at its
			 * end, so the connection light does not shift when a request tab comes and goes.
			 */}
			<div
				className="flex items-center h-[var(--dock-height)] px-2 gap-2 border-t border-border bg-panel shrink-0"
				// The last stop in the F6 cycle (`region-focus.ts`, #3498): without
				// it the save status and the per-tab view controls are reached
				// only by tabbing through everything above them.
				{...regionProps("dock")}
			>
				<div className="flex-1" aria-hidden="true" />

				{/* Ambient status */}
				<div className="flex items-center justify-center gap-4">
					<EngineStatus />

					<RunningServices />

					<PendingRestart />

					{/*
					 * "Unsaved changes" is the only place in the app that says so. The tab strip
					 * has no unsaved dot because auto-save is the safety net, but auto-save can be
					 * turned off, and then nothing else says an edit is unwritten. Unconditional,
					 * with `SaveStatusLine` animating its own track: gated spans slid the
					 * connection light and the version string on every edit.
					 */}
					<SaveStatusLine />

					{/*
					 * Full muted-foreground, not /50: at half opacity the version measured 2.71:1
					 * dark and 1.94:1 light, and `subtle-foreground` (3.63 / 3.04), the faintest
					 * *readable* tier, is still under AA for 12px text. A version string is
					 * information, not decoration, so it gets a passing colour.
					 */}
					<EngineVersion />
				</div>

				{/* The bottom panel's button on every tab, then the per-tab view
				    controls - a request tab's only, for now. */}
				<div className="flex-1 flex items-center justify-end gap-1">
					<BottomPanelButton />
					{activeTabType === "request" && <ResponsePositionButton />}
				</div>
			</div>
		</>
	);
}

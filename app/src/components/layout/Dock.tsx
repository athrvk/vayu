/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import {
	FolderOpen,
	Clock,
	Braces,
	Info,
	PanelRight,
	Radio,
	RefreshCw,
	Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatChord } from "@/lib/platform";
import { DRAWER_VIEW_CHORDS, TOGGLE_CONTEXT_BAR_CHORD } from "@/constants/shortcuts";
import {
	useLayoutStore,
	useEngineStore,
	useSaveStore,
	useTabsStore,
	type DrawerView,
} from "@/stores";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { contextBarHasContent } from "./context-bar-content";
import { useRunningServiceCount } from "@/modules/services";
import { useEngineRestart } from "@/hooks/useEngineRestart";

interface DrawerButton {
	view: DrawerView;
	icon: React.ReactNode;
	label: string;
	shortcut: string;
}

const DRAWER_BUTTONS: DrawerButton[] = [
	{
		view: "collections",
		icon: <FolderOpen className="w-4 h-4" />,
		label: "Collections",
		shortcut: formatChord(DRAWER_VIEW_CHORDS.collections),
	},
	{
		view: "history",
		icon: <Clock className="w-4 h-4" />,
		label: "History",
		shortcut: formatChord(DRAWER_VIEW_CHORDS.history),
	},
	{
		view: "variables",
		/*
		 * `Braces`, not `Zap`. The lightning bolt is this app's load-test mark -
		 * it is the Load Test button in the URL bar, the dashboard tab icon, and
		 * the badge on a load run in History. Sitting in the Dock it said "run",
		 * which is the one thing this view does not do.
		 *
		 * `{}` is the strongest reading of "variables" here because it *is* the
		 * syntax: every variable in Vayu is written `{{name}}`, in the URL bar,
		 * in headers, in bodies, in scripts. The user has already learned the
		 * glyph before they ever look at the Dock.
		 *
		 * Rejected: `Variable` (lucide's `(x)`) is maths notation, not ours, and
		 * its centre crossing packs a 6-unit X into a 24-unit box - at 16px that
		 * is roughly 4px of detail, and it gives the icon the same
		 * round-with-something-inside silhouette as Clock and Settings.
		 * `SquareCode` (`<>` in a box) reads "script", and Vayu has real pre/post
		 * scripts to confuse it with. `Parentheses` is `Variable` minus the X:
		 * unreadable on its own, and it says "call", not "value".
		 *
		 * Distinctness in the strip: Braces is two thin open curves with a gap
		 * down the middle, the only glyph of the four that is not a closed or
		 * centre-filled shape - Collections is a solid horizontal trapezoid,
		 * History a filled circle, Settings a round cog.
		 *
		 * Kept in step with `variables/main/VariablesMain.tsx` (empty state) and
		 * `welcome/Launcher.tsx` (the Variables tile), which drew the same
		 * concept as `Variable` and `Database` respectively.
		 */
		icon: <Braces className="w-4 h-4" />,
		label: "Variables",
		shortcut: formatChord(DRAWER_VIEW_CHORDS.variables),
	},
	{
		view: "services",
		/*
		 * `Radio`: the group is inboxes, OAuth issuers and (with #481) mock
		 * servers - things that sit there *listening*, which is what the
		 * broadcast arcs say and what none of the alternatives do. `Server`
		 * reads as a remote host, which is the thing these stand in for rather
		 * than what they are; `Play` is the load-test run mark; `Plug` reads as
		 * a connection to something else, and the point of a local service is
		 * that there is nothing else.
		 *
		 * Distinct in the strip: it is the only glyph made of concentric arcs -
		 * Collections a solid trapezoid, History a filled circle, Variables two
		 * open curves, Settings a round cog.
		 */
		icon: <Radio className="w-4 h-4" />,
		label: "Services",
		shortcut: formatChord(DRAWER_VIEW_CHORDS.services),
	},
	{
		view: "settings",
		icon: <Settings className="w-4 h-4" />,
		label: "Settings",
		shortcut: formatChord(DRAWER_VIEW_CHORDS.settings),
	},
];

interface DockButtonProps {
	active: boolean;
	onClick: () => void;
	/** What the button is. Becomes both the accessible name and the tooltip. */
	label: string;
	/** Shown after the label in the tooltip; deliberately not in the name. */
	shortcut?: string;
	children: React.ReactNode;
}

/**
 * These buttons are icon-only, so the label is the only thing that names them.
 * A Radix tooltip is not a substitute: it supplies `aria-describedby` while
 * open, never an accessible *name*, so the button announced as just "button".
 * Taking `label` rather than a prebuilt tooltip string means the name is
 * derived here and cannot be omitted at a call site.
 *
 * The shortcut stays out of the accessible name - it is useful on hover but
 * turns the name into "Collections Control Shift E" when read aloud.
 */
function DockButton({ active, onClick, label, shortcut, children }: DockButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					onClick={onClick}
					aria-label={label}
					aria-pressed={active}
					className={cn(
						"flex items-center justify-center w-7 h-7 rounded-md text-xs transition-colors",
						active
							? "bg-accent text-accent-foreground"
							: "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
					)}
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent side="top">
				<p>{shortcut ? `${label} ${shortcut}` : label}</p>
			</TooltipContent>
		</Tooltip>
	);
}

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
 */
function EngineStatus() {
	const isEngineConnected = useEngineStore((s) => s.isEngineConnected);
	const engineError = useEngineStore((s) => s.engineError);

	/*
	 * success-text, not status-success. The status tokens are tuned as fills and
	 * indicators; as 12px text `status-success` measures 2.21:1 on the light
	 * panel, well under the 4.5 AA needs. The `-text` variant is the accessible
	 * pair (4.57 light / 9.58 dark) and the dot inherits it via bg-current,
	 * clearing the 3:1 that non-text indicators need too.
	 */
	const className = cn(
		"flex items-center gap-1 text-xs",
		isEngineConnected ? "text-success-text" : "text-muted-foreground"
	);
	const label = (
		<>
			<span className="w-1.5 h-1.5 rounded-full bg-current" />
			{isEngineConnected ? "Connected" : "Disconnected"}
		</>
	);

	if (isEngineConnected || !engineError) {
		return <span className={className}>{label}</span>;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					tabIndex={0}
					className={cn(
						className,
						"cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					)}
				>
					{label}
					<Info className="w-3 h-3" aria-hidden="true" />
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
 * **Nothing renders when nothing runs** - and a disconnected engine is running
 * nothing, which `useRunningServiceCount` is what decides (it holds the gate,
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
				 * it can be stopped or copied. `success-text` is the accessible
				 * pair the connection light above uses for the same 12px dot.
				 */}
				<button
					onClick={() => revealDrawerView("services")}
					className="flex items-center gap-1 text-xs text-success-text rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
				 */}
				<button
					onClick={() => void restart()}
					disabled={isRestarting}
					className="flex items-center gap-1 text-xs text-warning-text rounded-sm hover:underline disabled:no-underline disabled:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<RefreshCw
						className={cn("w-3 h-3", isRestarting && "animate-spin")}
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
	const { drawerOpen, drawerView, activateDrawerView, contextBarOpen, toggleContextBar } =
		useLayoutStore();
	const { openTabs, activeTabId } = useTabsStore();
	const saveStatus = useSaveStore((s) => s.status);

	// "Open" is not the same as "on screen": the bar renders nothing off a request
	// tab, so a button pressed on `contextBarOpen` alone lit up with nothing to
	// show. Pressed mirrors what is visible instead - the toggle still works, and
	// the state it reports is the state the user can see.
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const contextBarVisible = contextBarOpen && contextBarHasContent(activeTab);

	// No TooltipProvider of its own. A bare nested one would reset this strip to
	// Radix's 700ms default, ignoring the app-wide delay set in main.tsx.
	return (
		<>
			{/*
			 * Height comes from --dock-height, not a bare `h-8`, because the toast
			 * viewport is `fixed` and has to offset itself above this strip - see
			 * `ui/toast.tsx`. Same value (2rem); the token is what keeps the two
			 * from drifting apart.
			 */}
			<div className="flex items-center h-[var(--dock-height)] px-2 gap-2 border-t border-border bg-panel shrink-0">
				{/* Left - drawer switchers.
				    <nav>: these five choose what the sidebar shows, which is the
				    app's primary navigation. Not role="toolbar" - that promises
				    arrow-key traversal between the buttons, which this does not
				    implement, and claiming it would mislead a keyboard user. */}
				<nav className="flex items-center gap-0.5" aria-label="Sidebar views">
					{DRAWER_BUTTONS.map(({ view, icon, label, shortcut }) => (
						<DockButton
							key={view}
							active={drawerOpen && drawerView === view}
							onClick={() => activateDrawerView(view)}
							label={label}
							shortcut={shortcut}
						>
							{icon}
						</DockButton>
					))}
				</nav>

				{/* Middle - ambient status */}
				<div className="flex-1 flex items-center justify-center gap-4">
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
					 */}
					{saveStatus === "pending" && (
						<span className="text-xs text-muted-foreground">Unsaved changes</span>
					)}
					{saveStatus === "saving" && (
						<span className="text-xs text-muted-foreground">Saving…</span>
					)}
					{saveStatus === "saved" && (
						<span className="text-xs text-muted-foreground">Saved</span>
					)}
					{/*
					 * No error line here any more, on purpose.
					 *
					 * This strip used to render `save-store`'s `errorMessage`,
					 * added because a bare "Save failed" never said *why*. The
					 * reason still has to reach the user; it now arrives as a
					 * toast, which is where every other failure in the app is
					 * reported, and which - unlike a 60-character truncated span
					 * with the rest in a `title` - has room for an engine message
					 * like "database is locked".
					 *
					 * Guarded by `Dock.save-error.test.tsx`: same requirement, a
					 * failure says why, asserted against the toast instead.
					 */}

					{/*
					 * Full muted-foreground, not /50. At half opacity the version
					 * measured 2.71:1 dark and 1.94:1 light - the only element in the
					 * app failing contrast. `subtle-foreground` would not fix it
					 * either (3.63 / 3.04); it is the faintest *readable* tier, still
					 * under AA for 12px text. A version string is information, not
					 * decoration, so it gets a passing colour.
					 */}
					<span className="text-xs text-muted-foreground">v{__VAYU_VERSION__}</span>
				</div>

				{/* Right - toggles */}
				<div className="flex items-center gap-0.5">
					<DockButton
						active={contextBarVisible}
						onClick={toggleContextBar}
						label="Toggle context bar"
						shortcut={`(${formatChord(TOGGLE_CONTEXT_BAR_CHORD)})`}
					>
						<PanelRight className="w-4 h-4" />
					</DockButton>
				</div>
			</div>
		</>
	);
}

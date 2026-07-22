/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { FolderOpen, Clock, Braces, PanelRight, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatChord } from "@/lib/platform";
import { useLayoutStore, useEngineStore, useSaveStore, type DrawerView } from "@/stores";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui";

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
		shortcut: formatChord({ mod: true, shift: true, key: "E" }),
	},
	{
		view: "history",
		icon: <Clock className="w-4 h-4" />,
		label: "History",
		shortcut: formatChord({ mod: true, shift: true, key: "H" }),
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
		shortcut: formatChord({ mod: true, shift: true, key: "U" }),
	},
	{
		view: "settings",
		icon: <Settings className="w-4 h-4" />,
		label: "Settings",
		shortcut: formatChord({ mod: true, key: "," }),
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

export function Dock() {
	const { drawerOpen, drawerView, activateDrawerView, contextBarOpen, toggleContextBar } =
		useLayoutStore();
	const { isEngineConnected } = useEngineStore();
	const { status: saveStatus, errorMessage: saveError } = useSaveStore();

	return (
		<TooltipProvider>
			<div className="flex items-center h-8 px-2 gap-2 border-t border-border bg-panel shrink-0">
				{/* Left - drawer switchers.
				    <nav>: these four choose what the sidebar shows, which is the
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
					{/*
					 * success-text, not status-success. The status tokens are tuned as
					 * fills and indicators; as 12px text `status-success` measures
					 * 2.21:1 on the light panel, well under the 4.5 AA needs. The
					 * `-text` variant is the accessible pair (4.57 light / 9.58 dark)
					 * and the dot inherits it via bg-current, clearing the 3:1 that
					 * non-text indicators need too.
					 */}
					<span
						className={cn(
							"flex items-center gap-1 text-xs",
							isEngineConnected ? "text-success-text" : "text-muted-foreground"
						)}
					>
						<span className="w-1.5 h-1.5 rounded-full bg-current" />
						{isEngineConnected ? "Connected" : "Disconnected"}
					</span>

					{saveStatus === "saving" && (
						<span className="text-xs text-muted-foreground">Saving…</span>
					)}
					{saveStatus === "saved" && (
						<span className="text-xs text-muted-foreground">Saved</span>
					)}
					{/*
					 * The reason, not just the fact. `save-store` records an
					 * `errorMessage` on every failure - "database is locked", "disk
					 * full" - and nothing read it, so every failure looked the same
					 * and none of them said what to do about it. Same shape as three
					 * failures found in the dashboard: state written, never read.
					 *
					 * `title` carries the full text because the strip is narrow and
					 * the message comes from the engine, so its length is not ours to
					 * predict.
					 */}
					{saveStatus === "error" && (
						<span
							className="max-w-60 truncate text-xs text-destructive-text"
							title={saveError ?? undefined}
						>
							{saveError ? `Save failed - ${saveError}` : "Save failed"}
						</span>
					)}

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
						active={contextBarOpen}
						onClick={toggleContextBar}
						label="Toggle context bar"
						shortcut={`(${formatChord({ mod: true, key: "I" })})`}
					>
						<PanelRight className="w-4 h-4" />
					</DockButton>
				</div>
			</div>
		</TooltipProvider>
	);
}

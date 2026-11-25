/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The window's own row: app identity, the search bar, the environment switcher and the window
 * controls. The document tabs are a second row scoped to the content area (`Shell`), because this
 * row cannot hold both: tabs are content-width and overflow into a dropdown, so every pixel another
 * control takes here is overflowed tabs, and a real search bar is worth ~360 of them.
 *
 * Height from --titlebar-height, not a bare 38px literal: the toast viewport subtracts it when the
 * stack is anchored to the top of the window. The value must still match TITLEBAR_HEIGHT in
 * electron/constants.ts, which sizes the real window frame and cannot read a CSS variable.
 *
 * - macOS: traffic lights inset (~104px), no HTML controls.
 * - Windows: the native overlay draws the controls, no HTML buttons.
 * - Linux: custom HTML min/max/close buttons.
 * - Windows and Linux: the app icon opens the application menu, which a frameless window draws no
 *   bar for (#1361).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	Minus,
	X,
	Maximize2,
	Square,
	Check,
	ChevronDown,
	Cloud,
	ArrowLeft,
	ArrowRight,
	Plus,
	Download,
} from "lucide-react";
import {
	canGoBack,
	canGoForward,
	useEnvSwitcherStore,
	useImportModalStore,
	useSessionStore,
	useTabsStore,
	useToastStore,
} from "@/stores";
import {
	useCreateEnvironmentMutation,
	useEnvironmentsQuery,
	useSetActiveEnvironmentMutation,
} from "@/queries";
import { useVariablesStore } from "@/modules/variables/variables-store";
import { DEFAULT_ENVIRONMENT_NAME } from "@/constants/environment";
import type { Environment } from "@/types";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	ICON_MOTION,
	TooltipIconButton,
} from "@/components/ui";
import {
	APP_MENU_CHORD,
	GO_BACK_CHORD,
	GO_FORWARD_CHORD,
	matchesChord,
} from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";
import { navigateHistory } from "@/lib/navigate-history";
import { cn } from "@/lib/utils";
import { isCommitEnter } from "@/lib/keyboard";
import { createAltTapWatcher } from "@/lib/alt-tap";
import { isModalOpen } from "@/lib/modal";
import { CommandSearchBar } from "./CommandSearchBar";
import { regionProps } from "./region-focus";
import iconUrl from "@shared/icon_png/vayu_icon_256x256.png";

const isElectron = !!window.electronAPI;
const isMac = window.electronAPI?.platform === "darwin";
const isWindows = window.electronAPI?.platform === "win32";
const isLinux = isElectron && !isMac && !isWindows;
/** The platforms whose frameless window draws no menu bar of its own (#1361). */
const hasMenuButton = isWindows || isLinux;

function WindowControls() {
	const [isMaximized, setIsMaximized] = useState(false);

	useEffect(() => {
		window.electronAPI?.windowIsMaximized().then(setIsMaximized);
		const cleanup = window.electronAPI?.onWindowMaximized(setIsMaximized);
		return cleanup;
	}, []);

	return (
		<div
			className="flex items-center h-full"
			style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
		>
			<button
				onClick={() => window.electronAPI?.windowMinimize()}
				className="h-full min-w-target px-3 hover:bg-muted/50 transition-[background-color,color,border-color,opacity,scale] duration-150 active:scale-[0.98] flex items-center justify-center"
				aria-label="Minimize"
			>
				<Minus className="size-icon text-foreground/70" />
			</button>
			<button
				onClick={() => window.electronAPI?.windowMaximize()}
				className="h-full min-w-target px-3 hover:bg-muted/50 transition-[background-color,color,border-color,opacity,scale] duration-150 active:scale-[0.98] flex items-center justify-center"
				aria-label={isMaximized ? "Restore" : "Maximize"}
			>
				{isMaximized ? (
					<Maximize2 className="size-icon-sm text-foreground/70" />
				) : (
					<Square className="size-icon-sm text-foreground/70" />
				)}
			</button>
			<button
				onClick={() => window.electronAPI?.windowClose()}
				className="h-full min-w-target px-3 hover:bg-destructive hover:text-destructive-foreground transition-[background-color,color,border-color,opacity,scale] duration-150 active:scale-[0.98] flex items-center justify-center group"
				aria-label="Close"
			>
				<X
					className="size-icon text-foreground/70 group-hover:text-destructive-foreground"
					data-icon-motion={ICON_MOTION.rotate90}
				/>
			</button>
		</div>
	);
}

/**
 * The app icon: the application menu's only surface on Windows and Linux, and the Windows
 * system-menu control besides. A frameless window draws no menu bar on either platform, so File,
 * Edit, View, Window and Help would be accelerators and nothing else, and the items with none
 * (`Help > Documentation`, About Vayu, Check for updates) reachable by no mouse at all (#1361).
 * Left click opens the menu the main process already installed; nothing is rebuilt here, and the
 * renderer never learns what is in it.
 *
 * On Windows the title-bar icon opens the *system* menu on left click, right click and Alt+Space. A
 * `-webkit-app-region: drag` area is a non-client frame, where Windows pops the real menu on right
 * click, but it ignores every pointer event, so left click cannot be added on top. So on Windows
 * the icon leaves the drag region, right click keeps the system menu, and left click is the
 * application menu. The 44px of drag surface that costs matches Win32: a real title-bar icon is
 * HTSYSMENU, which does not drag the window either.
 */
function AppIcon() {
	// The keyboard paths open the menu from the pointer's anchor, and F10 has no `currentTarget` to
	// read it from, so the element answers rather than the event.
	const anchor = useRef<HTMLDivElement>(null);

	const openAppMenu = useCallback(() => {
		// Anchored to the icon's bottom-left, so the menu drops from the control
		// rather than from the pointer - which is what a menu bar does.
		const r = anchor.current?.getBoundingClientRect();
		if (!r) return;
		window.electronAPI?.windowAppMenu({ x: r.left, y: r.bottom });
	}, []);

	useEffect(() => {
		if (!hasMenuButton) return;
		// The window's chords are bound on `window`, so they fire wherever focus is, including
		// inside an open dialog, which owns the window while it is up (#935).
		const open = () => {
			if (isModalOpen()) return;
			openAppMenu();
		};
		const altTap = createAltTapWatcher(open);
		const onKeyDown = (e: KeyboardEvent) => {
			altTap.keydown(e);
			if (!matchesChord(e, APP_MENU_CHORD)) return;
			e.preventDefault();
			open();
		};
		const onKeyUp = (e: KeyboardEvent) => altTap.keyup(e);
		const cancel = () => altTap.cancel();
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		// Alt+Tab moves focus before the keyup lands, and a pointer press or a wheel
		// turn mid-hold is not a tap either (#3403: Alt+scroll is Monaco's fast
		// scroll). The wheel listener captures because Monaco stops the event's
		// propagation when it scrolls, so a bubble listener on `window` never
		// hears the turn that matters.
		window.addEventListener("blur", cancel);
		window.addEventListener("pointerdown", cancel);
		window.addEventListener("wheel", cancel, { capture: true, passive: true });
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", cancel);
			window.removeEventListener("pointerdown", cancel);
			window.removeEventListener("wheel", cancel, { capture: true });
		};
	}, [openAppMenu]);

	/*
	 * Windows and Linux. macOS states app identity twice already (the Dock icon, the menu bar) and
	 * its traffic lights own this corner, so a logo there is the second app mark in the same 124px;
	 * its menu bar already draws the same template, so it needs no button either.
	 *
	 * On Linux the icon is for the menu, not branding: GNOME's header bars carry no app icon but do
	 * carry the window's menus, and Vayu draws client-side decorations there, so this is the
	 * header-bar menu button, where every other client-side-decorated app draws one.
	 */
	if (!hasMenuButton) return null;

	return (
		<div
			ref={anchor}
			// 16px at a 16px inset, per the Windows title-bar spec: "the size of the window icon is
			// 16px by 16px", placed "16px from the left-most border" and vertically centred.
			className="flex items-center pl-4 pr-3 shrink-0"
			style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			onClick={(e) => {
				e.preventDefault();
				openAppMenu();
			}}
			// Windows only: out of the drag region the icon loses the platform's own right-click
			// menu. Linux has no system menu to offer, so the right click falls through to the
			// app's context menu.
			onContextMenu={(e) => {
				if (!isWindows) return;
				e.preventDefault();
				const r = e.currentTarget.getBoundingClientRect();
				window.electronAPI?.windowSystemMenu({ x: r.left, y: r.bottom });
			}}
			// Windows closes the window on a double-click of the icon, a convention of the icon
			// alone: the rest of the bar toggles maximise, which the drag region gives. On Linux it
			// is no convention, and a double click there is two menu openings.
			onDoubleClick={(e) => {
				if (!isWindows) return;
				e.preventDefault();
				window.electronAPI?.windowClose();
			}}
			// A `role="button"` owes the keyboard what a real button gives for free: a tab stop and
			// Enter/Space. Alt+Space reaches the system menu on Windows, but the control sits in
			// the tab order of a reachable first row, and a pointer-only control fails jsx-a11y in
			// the build. Space is matched on `e.key`, not a chord: it is the button-activation key,
			// not an app shortcut.
			tabIndex={0}
			onKeyDown={(e) => {
				const activates = isCommitEnter(e) || (e.key === " " && !e.ctrlKey && !e.metaKey);
				if (!activates) return;
				e.preventDefault();
				openAppMenu();
			}}
			role="button"
			aria-label="Application menu"
			aria-haspopup="menu"
		>
			<img src={iconUrl} alt="" className="size-icon" />
		</div>
	);
}

/**
 * Back and Forward, at the window's leading edge (#1245), where browsers, Finder, Explorer and VS
 * Code put the pair. The title bar, not beside the tab strip: they navigate the whole workspace,
 * and a tab closed three steps ago is somewhere Back can still go, with no row in the strip. Each
 * button is disabled while its half of the history is empty, greyed like a browser's until there is
 * somewhere to go.
 */
function NavigationControls() {
	const back = useTabsStore(canGoBack);
	const forward = useTabsStore(canGoForward);

	return (
		// Per-control `no-drag`, the pattern AppIcon and the env switcher follow -
		// a drag region swallows the click before the button sees it.
		<div
			className="flex items-center gap-0.5 pl-1 shrink-0"
			style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
		>
			<TooltipIconButton
				label="Back"
				tooltipHint={formatChord(GO_BACK_CHORD)}
				tooltipSide="bottom"
				icon={<ArrowLeft className="size-icon-sm" />}
				className="size-target"
				disabled={!back}
				onClick={() => navigateHistory("back", "ui")}
			/>
			<TooltipIconButton
				label="Forward"
				tooltipHint={formatChord(GO_FORWARD_CHORD)}
				tooltipSide="bottom"
				icon={<ArrowRight className="size-icon-sm" />}
				className="size-target"
				disabled={!forward}
				onClick={() => navigateHistory("forward", "ui")}
			/>
		</div>
	);
}

function EnvSwitcher() {
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const { data: environments = [] } = useEnvironmentsQuery();
	const setActiveEnvironment = useSetActiveEnvironmentMutation();
	const createEnvironment = useCreateEnvironmentMutation();
	const openTab = useTabsStore((s) => s.openTab);
	const setSelectedCategory = useVariablesStore((s) => s.setSelectedCategory);
	const openImport = useImportModalStore((s) => s.open);
	const showToast = useToastStore((s) => s.showToast);
	const menuOpen = useEnvSwitcherStore((s) => s.isOpen);
	const setMenuOpen = useEnvSwitcherStore((s) => s.setOpen);
	const activeEnv = environments.find((e) => e.id === activeEnvironmentId);

	/*
	 * Create-then-navigate only, like the Variables sidebar's `handleCreateEnvironment`: it does
	 * not activate the environment. Creating one is not choosing to make it live; that stays a
	 * separate choice, through `selectEnvironment` below.
	 */
	const createNewEnvironment = async () => {
		let newEnv: Environment;
		try {
			newEnv = await createEnvironment.mutateAsync({
				name: DEFAULT_ENVIRONMENT_NAME,
				variables: {},
			});
		} catch (error) {
			const fallback = "Couldn't create the environment";
			showToast({
				message: error instanceof Error ? `${fallback} - ${error.message}` : fallback,
				variant: "error",
			});
			return;
		}
		setSelectedCategory({ type: "environment", environmentId: newEnv.id });
		openTab({ type: "variables", entityId: null });
	};

	/*
	 * Switching environment is a silent change with loud consequences: every {{variable}} in every
	 * open request resolves against the new one, so the same Send can hit a different host, and
	 * this button's label, the only other feedback, is not where the user looks once the menu
	 * closes. The toast confirms the destination, not the act ("Environment: Staging", not
	 * "Environment switched"), so it answers what a glance is asking. Selecting the active
	 * environment changes nothing and says nothing.
	 */
	const selectEnvironment = (id: string | null) => {
		if (id === activeEnvironmentId) return;
		/*
		 * The switch is persisted engine-side, not just in this window: the mutation writes
		 * `isActive` and the store optimistically, and rolls the store back if the engine refuses.
		 * So the toast confirms only what the engine accepted: a selection that failed to store
		 * comes back as the old one on the next launch, and a toast naming it would be a lie found
		 * tomorrow.
		 */
		const name = id ? environments.find((e) => e.id === id)?.name : null;
		setActiveEnvironment.mutate(
			{ id },
			{
				onSuccess: () =>
					showToast({
						message: name ? `Environment: ${name}` : "Environment cleared",
						variant: "info",
					}),
				onError: (error) =>
					showToast({
						message:
							error instanceof Error
								? `Couldn't switch environment: ${error.message}`
								: "Couldn't switch environment",
						variant: "error",
					}),
			}
		);
	};

	return (
		<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
			<DropdownMenuTrigger asChild>
				<button
					className={cn(
						// rounded-md, not rounded-full: an interactive control's corners follow the
						// Appearance → Roundedness setting, and rounded-full is for non-interactive
						// indicators. `max-w-3xs` (16rem, Tailwind's container scale), not
						// `max-w-44`, which rides `--spacing` and truncates names shorter at the
						// Default density: this bounds a name before it truncates, not chrome
						// rhythm. `min-w-0`, not `shrink-0`: in a narrow window the switcher gives
						// way (the name truncates to the icon and chevron) instead of overlapping
						// the search bar beside it (#3494).
						"flex items-center gap-1.5 max-w-3xs min-w-0 text-xs pl-2.5 pr-2 py-0.5 rounded-md",
						// Explicit property list, not `transition-colors`: a hand-rolled button has
						// no `[data-slot="button"]`, so it misses the baseline's `scale` press
						// feedback (`index.css`), added here at the colour properties' duration
						// (`UrlBar`'s Send button is the worked example).
						"transition-[background-color,color,border-color,opacity,scale] duration-150 active:scale-[0.98]",
						// Border on both states, transparent when idle, so selecting an
						// environment does not resize the control by 2px.
						"border",
						activeEnv
							? /*
								 * Tracks the accent, like every other "this is selected" surface
								 * (the Appearance cards, the active tab's rule): a pill that stays
								 * blue under Coral is the one thing off the scheme.
								 *
								 * `--primary-text` for the label, not `--primary`: here the accent
								 * *is* the text, and on graphite `--primary` is a neutral, grey on
								 * a grey tint. `--primary-tint` and its hover, not an alpha of the
								 * accent: the label sits on this ground, so it has to be one the
								 * contrast test measures.
								 *
								 * Not `bg-accent`: that is the **hover** background token
								 * (`--accent-active` is the selected one), and as a resting fill
								 * hovered to an alpha of itself the control got lighter under the
								 * pointer, not stronger.
								 */
								"bg-primary-tint text-primary-text border-primary/30 hover:bg-primary-tint-hover"
							: "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
					)}
					// Per-control opt-out, as AppIcon and CommandSearchBar's trigger do.
					// `DropdownMenuTrigger asChild` renders this button in place with no wrapper
					// node, so the declaration lands on the real element.
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<Cloud className="size-icon-sm shrink-0" />
					{/* A prefix, not an `aria-label`: a label replaces the visible
					    text, so a speech-control user saying "click Staging" matched
					    nothing (WCAG 2.5.3 Label in Name). */}
					<span className="sr-only">Environment: </span>
					<span className="truncate">{activeEnv?.name ?? "No environment"}</span>
					{/* The control's colour: an opacity would dim a tinted foreground twice. */}
					<ChevronDown className="size-icon-sm shrink-0" />
				</button>
			</DropdownMenuTrigger>
			{/* `min-w-3xs`, not `min-w-44`: the `--spacing` rule at the switcher pill above. */}
			<DropdownMenuContent align="end" className="min-w-3xs">
				<DropdownMenuItem
					onClick={() => void createNewEnvironment()}
					// `group`: the menu item is the owner whose hover the glyph
					// answers - a DropdownMenuItem is not a `[data-slot="button"]`.
					className="group text-xs gap-2"
				>
					<Plus className="size-icon-sm" data-icon-motion={ICON_MOTION.rotate90} />
					<span className="flex-1">New environment</span>
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={openImport}
					// `group`: the hover owner, as on the New environment item above.
					className="group text-xs gap-2"
				>
					<Download className="size-icon-sm" data-icon-motion={ICON_MOTION.drop} />
					<span className="flex-1">Import environment…</span>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => selectEnvironment(null)} className="text-xs gap-2">
					<span className="flex-1">No environment</span>
					{!activeEnv && <Check className="size-icon-sm" />}
				</DropdownMenuItem>
				{environments.map((env) => (
					<DropdownMenuItem
						key={env.id}
						onClick={() => selectEnvironment(env.id)}
						className="text-xs gap-2"
					>
						<span className="flex-1 truncate">{env.name}</span>
						{env.id === activeEnvironmentId && <Check className="size-icon-sm" />}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export default function TitleBar() {
	if (!isElectron) return null;

	return (
		// <header>: the app's banner region, reachable as a landmark rather than an unnamed div.
		//
		// A 3-column grid, not flex with spacers: the search bar is centred on the *window*, which
		// is what "command center" means in every app that has one, and equal 1fr side columns are
		// the only way to get that when the two clusters differ in width. Both sides carry
		// `min-w-0`, so a long environment name truncates instead of pushing the bar off centre,
		// and `minmax(0,1fr)` spells that minimum out in the grid, so a side cluster can never
		// widen its column.
		<header
			className="titlebar h-[var(--titlebar-height)] grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center bg-panel border-b border-border shrink-0 select-none"
			style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
			// A stop in the F6 cycle (`region-focus.ts`). Absent outside Electron, as is this whole
			// bar, so the cycle has three stops there.
			{...regionProps("banner")}
		>
			<div className="flex min-w-0 items-center h-full">
				{/* macOS: space for native traffic lights */}
				{/* Reserved for the traffic lights; the width is a token so it cannot
				    drift from the position Electron gives them. */}
				{isMac && <div className="shrink-0 w-[var(--traffic-light-inset)]" />}

				{/*
				 * Windows and Linux, where it opens the application menu (on Windows, the system
				 * menu on right click too). The icon is imported as a module, not referenced as
				 * "/icon.png": the import puts it into `dist/`, and no root-level icon is shipped.
				 */}
				<AppIcon />

				{/* Leading edge, after the icon and the traffic-light inset - where
				    a window's navigation controls go on every platform. */}
				<NavigationControls />
			</div>

			{/*
			 * The palette's entry point. Bounded, not fluid: a search field the width of the window
			 * reads as a document title, and the row's remaining area stays draggable. 28rem down
			 * to the 1024px window minimum, then giving way to a 2.5rem floor: with the bar
			 * centred, each side keeps 18rem, the room the environment switcher and Linux's window
			 * buttons need. A `min(44vw,28rem)` width holds 44vw at a narrow window (a 200%
			 * interface scale is a 512px one) and leaves the switcher 18px (#3494).
			 */}
			<CommandSearchBar className="w-[clamp(2.5rem,100vw_-_36rem,28rem)]" />

			{/* Right controls.
			    No `no-drag` here: this wrapper is the whole third 1fr column, so
			    opting it out would take the row's slack right of the search bar with
			    it - the largest drag surface on this side. Each control opts out on
			    itself instead (EnvSwitcher's trigger, WindowControls' own root), the
			    way AppIcon and CommandSearchBar already do. */}
			<div
				className="flex min-w-0 items-center justify-end gap-2 px-3 h-full"
				style={
					{
						// Windows paints native min/max/close as an overlay on the web content's
						// top-right corner; reserving its width (from the Window Controls Overlay
						// API) keeps the env switcher uncovered. The strip stays a drag region: the
						// OS hit-tests the overlay rectangle before the DOM sees it, so what the
						// page declares under it does not apply there.
						...(isWindows && {
							paddingRight: "calc(100vw - env(titlebar-area-width, 100vw) + 0.5rem)",
						}),
					} as React.CSSProperties
				}
			>
				<EnvSwitcher />
				{/* Linux only - Windows uses native overlay, macOS uses traffic lights */}
				{isLinux && <WindowControls />}
			</div>
		</header>
	);
}

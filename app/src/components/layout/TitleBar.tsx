/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Custom TitleBar Component
 *
 * The window's own row: app identity, the search bar, the environment switcher
 * and the window controls. The document tabs are *not* here - they moved to a
 * second row scoped to the content area (`Shell`), because this row could not
 * hold both. Tabs are content-width and overflow into a dropdown, so every
 * pixel another control took converted directly into overflowed tabs, and a
 * real search bar is worth ~360 of them.
 *
 * Height comes from --titlebar-height, not a bare h-[38px], because the toast
 * viewport subtracts it when the stack is anchored to the top of the window.
 * The value must still match TITLEBAR_HEIGHT in electron/constants.ts, which
 * sizes the real window frame and cannot read a CSS variable.
 * macOS: traffic lights inset (~104px), no HTML controls
 * Windows: native overlay handles controls - no HTML buttons
 * Linux: custom HTML min/max/close buttons
 */

import { useEffect, useState } from "react";
import { Minus, X, Maximize2, Square, Check, ChevronDown, Cloud } from "lucide-react";
import { useSessionStore, useToastStore } from "@/stores";
import { useEnvironmentsQuery, useSetActiveEnvironmentMutation } from "@/queries";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { CommandSearchBar } from "./CommandSearchBar";
import type { AppRegion } from "./region-focus";
import iconUrl from "@shared/icon_png/vayu_icon_256x256.png";

const isElectron = !!window.electronAPI;
const isMac = window.electronAPI?.platform === "darwin";
const isWindows = window.electronAPI?.platform === "win32";
const isLinux = isElectron && !isMac && !isWindows;

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
				className="h-full px-3 hover:bg-muted/50 transition-colors flex items-center justify-center"
				aria-label="Minimize"
			>
				<Minus className="w-4 h-4 text-foreground/70" />
			</button>
			<button
				onClick={() => window.electronAPI?.windowMaximize()}
				className="h-full px-3 hover:bg-muted/50 transition-colors flex items-center justify-center"
				aria-label={isMaximized ? "Restore" : "Maximize"}
			>
				{isMaximized ? (
					<Maximize2 className="w-3.5 h-3.5 text-foreground/70" />
				) : (
					<Square className="w-3.5 h-3.5 text-foreground/70" />
				)}
			</button>
			<button
				onClick={() => window.electronAPI?.windowClose()}
				className="h-full px-3 hover:bg-destructive hover:text-destructive-foreground transition-colors flex items-center justify-center group"
				aria-label="Close"
			>
				<X className="w-4 h-4 text-foreground/70 group-hover:text-destructive-foreground" />
			</button>
		</div>
	);
}

/**
 * The app icon, which on Windows is the system-menu control.
 *
 * Windows convention is that the title-bar icon opens the system menu on left
 * click, on right click, and on Alt+Space. Vayu had the right-click half for
 * free: a `-webkit-app-region: drag` area is treated as a non-client frame, and
 * Windows pops the real menu on it. Left click could not be added on top,
 * because a draggable area ignores every pointer event.
 *
 * So on Windows the icon leaves the drag region and both buttons are handled
 * here, against a menu built in the main process. Elsewhere it stays a plain
 * drag region - macOS and Linux have no such convention, and giving up the drag
 * area there would cost something and buy nothing.
 *
 * Losing 44px of drag surface on Windows is not a regression: a real Win32
 * title-bar icon is HTSYSMENU, which does not drag the window either.
 */
function AppIcon() {
	const openSystemMenu = (e: React.MouseEvent) => {
		e.preventDefault();
		// Anchored to the icon's bottom-left, so the menu drops from the control
		// rather than from the pointer - which is what the OS menu does.
		const r = e.currentTarget.getBoundingClientRect();
		window.electronAPI?.windowSystemMenu({ x: r.left, y: r.bottom });
	};

	/*
	 * Windows only.
	 *
	 * macOS states app identity twice already - the Dock icon and the menu bar -
	 * and its traffic lights own this corner, so a logo beside them is the second
	 * app mark in the same 124px. GNOME's header-bar contents are buttons, a
	 * heading and menus, with no app icon, and Vayu draws client-side decorations
	 * there; KDE shows one, but that is painted by the window manager, not the
	 * app, so it is not Vayu's to place.
	 *
	 * On Windows it stays because it is a control, not branding - see the system
	 * menu handler in electron/main.ts.
	 */
	if (!isWindows) return null;

	return (
		<div
			// 16px at a 16px inset, per the Windows title-bar spec: "the size of the
			// window icon is 16px by 16px", placed "16px from the left-most border"
			// and vertically centred. It was 20px at 12px.
			className="flex items-center pl-4 pr-3 shrink-0"
			style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			// Both buttons, because taking the icon out of the drag region is what
			// removed the platform's own right-click menu.
			onClick={openSystemMenu}
			onContextMenu={openSystemMenu}
			// Windows closes the window on a double-click of the icon. That is the
			// icon's convention specifically - double-clicking the rest of the bar
			// toggles maximise, which the drag region already gives us.
			onDoubleClick={(e) => {
				e.preventDefault();
				window.electronAPI?.windowClose();
			}}
			role="button"
			aria-label="System menu"
			aria-haspopup="menu"
		>
			<img src={iconUrl} alt="" className="w-4 h-4" />
		</div>
	);
}

function EnvSwitcher() {
	const { activeEnvironmentId } = useSessionStore();
	const { data: environments = [] } = useEnvironmentsQuery();
	const setActiveEnvironment = useSetActiveEnvironmentMutation();
	const showToast = useToastStore((s) => s.showToast);
	const activeEnv = environments.find((e) => e.id === activeEnvironmentId);

	/*
	 * Switching environment is a silent change with loud consequences: every
	 * {{variable}} in every open request resolves against the new one, so the
	 * same Send can hit a different host. The only feedback was this button's
	 * own label, which the user is not looking at once the menu closes over it.
	 *
	 * Confirms the destination rather than the act ("Environment: Staging", not
	 * "Environment switched"), so the toast still answers the question a glance
	 * is actually asking. Selecting the environment already active changes
	 * nothing and says nothing.
	 */
	const selectEnvironment = (id: string | null) => {
		if (id === activeEnvironmentId) return;
		/*
		 * The switch is persisted engine-side, not just in this window: the
		 * mutation writes `isActive` and the store optimistically, and rolls the
		 * store back if the engine refuses. So the toast confirms only what the
		 * engine accepted - a selection that failed to store would come back on
		 * the next launch as the old one, and saying "Environment: Staging" for
		 * it would be a lie the user only discovers tomorrow.
		 */
		const name = id ? environments.find((e) => e.id === id)?.name : null;
		setActiveEnvironment.mutate(
			{ id, previousId: activeEnvironmentId },
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
								? `Could not switch environment: ${error.message}`
								: "Could not switch environment",
						variant: "error",
					}),
			}
		);
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					className={cn(
						// rounded-md, not rounded-full: this is an interactive control,
						// so its corners follow the Appearance → Roundedness setting.
						// rounded-full is reserved for non-interactive indicators.
						"flex items-center gap-1.5 max-w-44 text-xs pl-2.5 pr-2 py-0.5 rounded-md shrink-0 transition-colors",
						// Border on both states, transparent when idle, so selecting an
						// environment does not resize the control by 2px.
						"border",
						activeEnv
							? /*
								 * Tracks the accent. Every other "this is selected" surface
								 * in the app does - the Appearance cards, the active tab's
								 * rule - so a pill that stayed blue while the accent was
								 * Coral was the one thing not following the scheme.
								 *
								 * `--primary-text` for the label rather than `--primary`,
								 * because here the accent *is* the text: on the graphite
								 * scheme `--primary` is a neutral and would read as grey on
								 * a grey tint.
								 *
								 * What it replaces is `bg-accent`, the **hover** background
								 * token (`--accent-active` is the selected one), used as a
								 * resting fill and hovered to an alpha of itself - so the
								 * control got lighter under the pointer, not stronger.
								 */
								"bg-primary/10 text-primary-text border-primary/30 hover:bg-primary/20"
							: "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
					)}
					// Per-control opt-out, the pattern AppIcon and CommandSearchBar's
					// trigger follow. `DropdownMenuTrigger asChild` renders this button
					// in place with no wrapper node, so the declaration lands on the
					// real element.
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
					aria-label="Switch environment"
				>
					<Cloud className="w-3 h-3 shrink-0" />
					<span className="truncate">{activeEnv?.name ?? "No Environment"}</span>
					{/* Inherits the control's colour: the old `opacity-60` was a magic
					    number that fought the tinted state, dimming an already-tinted
					    foreground a second time. */}
					<ChevronDown className="w-3 h-3 shrink-0" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-44">
				<DropdownMenuItem onClick={() => selectEnvironment(null)} className="text-xs gap-2">
					<span className="flex-1">No Environment</span>
					{!activeEnv && <Check className="w-3.5 h-3.5" />}
				</DropdownMenuItem>
				{environments.map((env) => (
					<DropdownMenuItem
						key={env.id}
						onClick={() => selectEnvironment(env.id)}
						className="text-xs gap-2"
					>
						<span className="flex-1 truncate">{env.name}</span>
						{env.id === activeEnvironmentId && <Check className="w-3.5 h-3.5" />}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export default function TitleBar() {
	if (!isElectron) return null;

	return (
		// <header>: the app's banner region, so it is reachable as a landmark
		// rather than being an unnamed div in the accessibility tree.
		//
		// A 3-column grid rather than flex-with-spacers: the search bar is centred
		// on the *window*, which is what "command center" means in every app that
		// has one, and equal 1fr side columns are the only way to get that when the
		// two clusters are different widths. Both sides carry `min-w-0` so a long
		// environment name truncates instead of pushing the bar off centre.
		<header
			className="titlebar h-[var(--titlebar-height)] grid grid-cols-[1fr_auto_1fr] items-center bg-panel border-b border-border shrink-0 select-none"
			style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
			// A stop in the F6 cycle - see `region-focus.ts`. Absent outside
			// Electron, where this whole bar is, and the cycle simply has three
			// stops there.
			data-app-region={"banner" satisfies AppRegion}
		>
			<div className="flex min-w-0 items-center h-full">
				{/* macOS: space for native traffic lights */}
				{/* Reserved for the traffic lights; the width is a token so it cannot
				    drift from the position Electron gives them. */}
				{isMac && <div className="shrink-0 w-[var(--traffic-light-inset)]" />}

				{/* Logo - Windows only (it is the system-menu control there). The icon
				    is imported as a module, not referenced as "/icon.png": `base: "./"`
				    means a root-absolute path does not resolve under the packaged
				    file:// build. */}
				<AppIcon />
			</div>

			{/* The palette's entry point. Bounded rather than fluid: a search field
			    the width of the window reads as a document title, and the row's whole
			    remaining area stays draggable. */}
			<CommandSearchBar className="w-[min(44vw,28rem)]" />

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
						// Windows paints native min/max/close as an overlay on top of the
						// web content in the top-right corner. Reserve its width (exposed by
						// the Window Controls Overlay API) so the env switcher isn't covered.
						// The strip stays a drag region: the overlay rectangle is hit-tested
						// by the OS before the DOM sees it, so what the page declares under
						// it does not apply there.
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

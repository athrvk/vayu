/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Custom TitleBar Component
 *
 * Height comes from --titlebar-height, not a bare h-[38px], because the toast
 * viewport subtracts it when the stack is anchored to the top of the window.
 * The value must still match TITLEBAR_HEIGHT in electron/constants.ts, which
 * sizes the real window frame and cannot read a CSS variable.
 * macOS: traffic lights inset (~80px), no HTML controls
 * Windows: native overlay handles controls - no HTML buttons
 * Linux: custom HTML min/max/close buttons
 */

import { useEffect, useState } from "react";
import { Minus, X, Maximize2, Square, Check, ChevronDown, Cloud } from "lucide-react";
import { useSessionStore, useToastStore } from "@/stores";
import { useEnvironmentsQuery } from "@/queries";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { TabStrip } from "./TabStrip";
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
				className="h-full px-4 hover:bg-muted/50 transition-colors flex items-center justify-center"
				aria-label="Minimize"
			>
				<Minus className="w-4 h-4 text-foreground/70" />
			</button>
			<button
				onClick={() => window.electronAPI?.windowMaximize()}
				className="h-full px-4 hover:bg-muted/50 transition-colors flex items-center justify-center"
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
				className="h-full px-4 hover:bg-destructive hover:text-destructive-foreground transition-colors flex items-center justify-center group"
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
		if (!isWindows) return;
		e.preventDefault();
		// Anchored to the icon's bottom-left, so the menu drops from the control
		// rather than from the pointer - which is what the OS menu does.
		const r = e.currentTarget.getBoundingClientRect();
		window.electronAPI?.windowSystemMenu({ x: r.left, y: r.bottom });
	};

	return (
		<div
			className="flex items-center px-3 shrink-0"
			style={{ WebkitAppRegion: isWindows ? "no-drag" : "drag" } as React.CSSProperties}
			// Both buttons, because taking the icon out of the drag region is what
			// removed the platform's own right-click menu.
			onClick={openSystemMenu}
			onContextMenu={openSystemMenu}
			// Only interactive where it does something.
			{...(isWindows
				? { role: "button", "aria-label": "System menu", "aria-haspopup": "menu" as const }
				: {})}
		>
			<img src={iconUrl} alt={isWindows ? "" : "Vayu"} className="w-5 h-5" />
		</div>
	);
}

function EnvSwitcher() {
	const { activeEnvironmentId, setActiveEnvironmentId } = useSessionStore();
	const { data: environments = [] } = useEnvironmentsQuery();
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
		setActiveEnvironmentId(id);
		const name = id ? environments.find((e) => e.id === id)?.name : null;
		showToast({
			message: name ? `Environment: ${name}` : "Environment cleared",
			variant: "info",
		});
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
						activeEnv
							? "bg-accent text-accent-foreground hover:bg-accent/80"
							: "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
					)}
					aria-label="Switch environment"
				>
					<Cloud className="w-3 h-3 shrink-0" />
					<span className="truncate">{activeEnv?.name ?? "No Environment"}</span>
					<ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
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
		<header
			className="titlebar h-[var(--titlebar-height)] flex items-center bg-panel border-b border-border shrink-0 select-none"
			style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
		>
			{/* macOS: space for native traffic lights */}
			{isMac && <div className="w-20 shrink-0" />}

			{/* Logo - all platforms. The icon is imported as a module, not referenced
			    as "/icon.png": `base: "./"` means a root-absolute path does not
			    resolve under the packaged file:// build. */}
			<AppIcon />

			{/* TabStrip - fills available width. This wrapper stays a drag region so
			    the empty space to the right of the last tab moves the window on every
			    platform; TabStrip marks its own tab row `no-drag`. */}
			<div
				className="flex-1 flex overflow-hidden h-full"
				style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
			>
				<TabStrip />
			</div>

			{/* Right controls */}
			<div
				className="flex items-center gap-2 px-3 shrink-0"
				style={
					{
						WebkitAppRegion: "no-drag",
						// Windows paints native min/max/close as an overlay on top of the
						// web content in the top-right corner. Reserve its width (exposed by
						// the Window Controls Overlay API) so the env switcher isn't covered.
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

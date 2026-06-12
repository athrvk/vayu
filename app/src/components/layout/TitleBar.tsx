/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Custom TitleBar Component
 *
 * h-[38px] — must match TITLEBAR_HEIGHT in electron/constants.ts
 * macOS: traffic lights inset (~80px), no HTML controls
 * Windows: native overlay handles controls — no HTML buttons
 * Linux: custom HTML min/max/close buttons
 */

import { useEffect, useState } from "react";
import { Minus, X, Maximize2, Square } from "lucide-react";
import { useSessionStore } from "@/stores";
import { useEnvironmentsQuery } from "@/queries";
import { TabStrip } from "./TabStrip";

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

function EnvPill() {
	const { activeEnvironmentId } = useSessionStore();
	const { data: environments = [] } = useEnvironmentsQuery();
	const activeEnv = environments.find((e) => e.id === activeEnvironmentId);

	if (!activeEnv) return null;

	return (
		<span className="text-xs px-2 py-0.5 rounded-full bg-accent text-accent-foreground shrink-0">
			{activeEnv.name}
		</span>
	);
}

export default function TitleBar() {
	if (!isElectron) return null;

	return (
		<div
			className="titlebar h-[38px] flex items-center bg-panel border-b border-border shrink-0 select-none"
			style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
		>
			{/* macOS: space for native traffic lights */}
			{isMac && <div className="w-20 shrink-0" />}

			{/* Logo — all platforms */}
			<div
				className="flex items-center px-3 shrink-0"
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			>
				<img
					src="/icon.png"
					alt="Vayu"
					className="w-5 h-5"
					onError={(e) => {
						(e.target as HTMLImageElement).style.display = "none";
					}}
				/>
			</div>

			{/* TabStrip — fills available width */}
			<div
				className="flex-1 flex overflow-hidden h-full"
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			>
				<TabStrip />
			</div>

			{/* Right controls */}
			<div
				className="flex items-center gap-2 px-3 shrink-0"
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			>
				<EnvPill />
				{/* Linux only — Windows uses native overlay, macOS uses traffic lights */}
				{isLinux && <WindowControls />}
			</div>
		</div>
	);
}

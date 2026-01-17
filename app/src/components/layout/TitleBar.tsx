/**
 * Custom TitleBar Component
 *
 * Provides a custom titlebar for frameless Electron window.
 * - macOS: Uses native traffic lights, this just provides drag region
 * - Windows/Linux: Shows custom window controls
 */

import { useEffect, useState } from "react";
import { Minus, Square, X, Maximize2 } from "lucide-react";

// Check if we're in Electron
const isElectron = !!window.electronAPI;
const isMac = window.electronAPI?.platform === "darwin";

export default function TitleBar() {
	const [isMaximized, setIsMaximized] = useState(false);

	useEffect(() => {
		if (!isElectron) return;

		// Get initial maximized state
		window.electronAPI?.windowIsMaximized().then(setIsMaximized);

		// Listen for maximize/unmaximize events
		const cleanup = window.electronAPI?.onWindowMaximized(setIsMaximized);
		return cleanup;
	}, []);

	// Don't render in browser
	if (!isElectron) {
		return null;
	}

	const handleMinimize = () => window.electronAPI?.windowMinimize();
	const handleMaximize = () => window.electronAPI?.windowMaximize();
	const handleClose = () => window.electronAPI?.windowClose();

	return (
		<div
			className="titlebar h-10 flex items-center justify-between bg-background border-b select-none"
			style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
		>
			{/* Left side - App branding */}
			<div className="flex items-center gap-2 px-3" style={{ marginLeft: isMac ? 70 : 0 }}>
				<img
					src="/icon.png"
					alt="Vayu"
					className="w-5 h-5"
					onError={(e) => {
						// Hide if icon not found
						(e.target as HTMLImageElement).style.display = "none";
					}}
				/>
				<span className="text-sm font-medium text-foreground/80">Vayu</span>
			</div>

			{/* Right side - Window controls (Windows/Linux only) */}
			{!isMac && (
				<div
					className="flex items-center h-full"
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<button
						onClick={handleMinimize}
						className="h-full px-4 hover:bg-muted/50 transition-colors flex items-center justify-center"
						aria-label="Minimize"
					>
						<Minus className="w-4 h-4 text-foreground/70" />
					</button>
					<button
						onClick={handleMaximize}
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
						onClick={handleClose}
						className="h-full px-4 hover:bg-destructive hover:text-destructive-foreground transition-colors flex items-center justify-center group"
						aria-label="Close"
					>
						<X className="w-4 h-4 text-foreground/70 group-hover:text-destructive-foreground" />
					</button>
				</div>
			)}
		</div>
	);
}

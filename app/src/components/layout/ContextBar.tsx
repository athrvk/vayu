/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore, useTabsStore } from "@/stores";
import { useVariableResolver } from "@/hooks/useVariableResolver";

interface ContextBarProps {
	mode?: "push" | "overlay";
}

export function ContextBar({ mode = "push" }: ContextBarProps) {
	const { contextBarOpen, setContextBarOpen } = useLayoutStore();
	const { openTabs, activeTabId } = useTabsStore();
	const activeTab = openTabs.find((t) => t.id === activeTabId);

	const { getAllVariables } = useVariableResolver();
	const variables = getAllVariables();

	if (!contextBarOpen || activeTab?.type !== "request") return null;

	return (
		<div
			className={cn(
				"flex flex-col shrink-0 border-l border-border bg-panel overflow-y-auto",
				mode === "overlay"
					? "absolute right-0 top-0 bottom-0 shadow-lg z-10"
					: "relative"
			)}
			style={{ width: 252 }}
		>
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
				<span className="text-xs font-medium text-foreground">Context</span>
				<button
					onClick={() => setContextBarOpen(false)}
					className="text-muted-foreground hover:text-foreground"
					aria-label="Close context bar"
				>
					<X size={14} />
				</button>
			</div>

			{/* Variables in scope */}
			<div className="p-3">
				<p className="text-xs font-medium text-muted-foreground mb-2">Variables in scope</p>
				{Object.entries(variables).length === 0 ? (
					<p className="text-xs text-muted-foreground">No variables in scope</p>
				) : (
					Object.entries(variables).map(([name, resolved]) => (
						<div key={name} className="flex justify-between text-xs py-0.5 gap-2">
							<span className="text-foreground font-mono shrink-0">{`{{${name}}}`}</span>
							<span className="text-muted-foreground truncate text-right">
								{resolved.secret ? "••••••" : resolved.value}
							</span>
						</div>
					))
				)}
			</div>
		</div>
	);
}

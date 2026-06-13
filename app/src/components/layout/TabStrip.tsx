/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TabStrip Component
 *
 * The horizontal row of open tabs rendered in the title bar. Reads from
 * tabs-store; one TabItem per open tab plus a "+" button that opens a
 * welcome tab. No unsaved-dot — autosave is the safety net (see
 * docs/app/redesign-layout.md).
 */

import { X, Plus, Folder, Zap, Clock, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabsStore, type Tab } from "@/stores";
import { useRequestQuery, useCollectionsQuery } from "@/queries";
import { useVariableResolver } from "@/hooks/useVariableResolver";

/**
 * Extract a short display path from a request URL. URLs may contain
 * {{variables}} or be malformed mid-edit, so this never throws.
 */
function pathLabel(url: string): string {
	if (!url) return "";
	try {
		return decodeURIComponent(new URL(url).pathname) || "/";
	} catch {
		// Strip scheme+host if present, otherwise show the raw string
		const stripped = url.replace(/^[a-z]+:\/\/[^/]*/i, "");
		return decodeURIComponent(stripped) || decodeURIComponent(url);
	}
}

function TabIcon({ type }: { type: Tab["type"] }) {
	switch (type) {
		case "collection":
			return <Folder size={12} className="shrink-0" />;
		case "dashboard":
			return <Zap size={12} className="shrink-0" />;
		case "run":
			return <Clock size={12} className="shrink-0" />;
		case "settings":
			return <Settings size={12} className="shrink-0" />;
		default:
			return null;
	}
}

function TabItem({ tab, isActive }: { tab: Tab; isActive: boolean }) {
	const { focusTab, closeTab } = useTabsStore();

	// Hooks run unconditionally (React rules); they no-op for non-matching types.
	const { data: request } = useRequestQuery(tab.type === "request" ? tab.entityId : null);
	const { data: collections = [] } = useCollectionsQuery();
	// Resolve {{variables}} in the URL so the tab shows the concrete path
	const { resolveString } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});

	let label: React.ReactNode;
	switch (tab.type) {
		case "welcome":
			label = "Vayu";
			break;
		case "settings":
			label = "Settings";
			break;
		case "variables":
			label = "Variables";
			break;
		case "request":
			label = request ? (
				<span className="inline-flex items-baseline gap-1.5 min-w-0">
					<span className="text-[10px] font-semibold uppercase shrink-0">
						{request.method}
					</span>
					<span className="truncate">
						{pathLabel(resolveString(request.url)) || request.name}
					</span>
				</span>
			) : (
				"Request"
			);
			break;
		case "collection":
			label = collections.find((c) => c.id === tab.entityId)?.name ?? "Collection";
			break;
		case "dashboard":
			label = "Load Test";
			break;
		case "run":
			label = "Run";
			break;
	}

	return (
		<div
			role="tab"
			aria-selected={isActive}
			tabIndex={0}
			onClick={() => focusTab(tab.id)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") focusTab(tab.id);
			}}
			onAuxClick={(e) => {
				// Middle-click closes, like browsers
				if (e.button === 1) closeTab(tab.id);
			}}
			className={cn(
				"group flex h-full min-w-20 max-w-50 shrink cursor-pointer select-none items-center gap-1.5 border-r border-border/40 px-3 text-sm",
				isActive
					? "bg-background text-foreground"
					: "border-b border-b-border bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground"
			)}
		>
			<TabIcon type={tab.type} />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<span
				role="button"
				tabIndex={-1}
				aria-label="Close tab"
				onClick={(e) => {
					e.stopPropagation();
					closeTab(tab.id);
				}}
				className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
			>
				<X size={12} />
			</span>
		</div>
	);
}

export function TabStrip() {
	const { openTabs, activeTabId, openTab } = useTabsStore();

	return (
		<div role="tablist" className="flex h-full min-w-0 items-stretch overflow-x-auto">
			{openTabs.map((tab) => (
				<TabItem key={tab.id} tab={tab} isActive={tab.id === activeTabId} />
			))}
			<button
				onClick={() => openTab({ type: "welcome", entityId: null })}
				aria-label="New tab"
				className="flex w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted/50 hover:text-foreground"
			>
				<Plus size={14} />
			</button>
		</div>
	);
}

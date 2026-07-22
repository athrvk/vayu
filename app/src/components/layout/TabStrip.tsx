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
 * welcome tab. No unsaved-dot - autosave is the safety net.
 */

import { useRef } from "react";
import { X, Plus, Folder, Zap, Clock, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabsStore, type Tab } from "@/stores";
import { useRequestQuery, useCollectionsQuery } from "@/queries";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { MethodBadge, ScrollOnOverflow } from "@/components/shared";

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

/**
 * Title for a request tab: the user-set name when there is one, otherwise the
 * request path. A blank or still-default placeholder name counts as "not set".
 */
function requestTabTitle(name: string, resolvedUrl: string): string {
	const trimmed = name.trim();
	if (trimmed && trimmed !== DEFAULT_REQUEST_NAME) return trimmed;
	return pathLabel(resolvedUrl) || trimmed;
}

function TabIcon({ type }: { type: Tab["type"] }) {
	switch (type) {
		case "collection":
			return <Folder className="w-3 h-3 shrink-0" />;
		case "dashboard":
			return <Zap className="w-3 h-3 shrink-0" />;
		case "run":
			return <Clock className="w-3 h-3 shrink-0" />;
		case "settings":
			return <Settings className="w-3 h-3 shrink-0" />;
		default:
			return null;
	}
}

function TabItem({ tab, isActive }: { tab: Tab; isActive: boolean }) {
	const { focusTab, closeTab } = useTabsStore();
	// Roving tabindex: the strip is one Tab stop, and Left/Right move within it.
	// Previously every tab carried tabIndex={0}, so a developer with a dozen tabs
	// open had to press Tab a dozen times to get past the strip.
	const rovingTabIndex = isActive ? 0 : -1;

	// Hooks run unconditionally (React rules); they no-op for non-matching types.
	const { data: request } = useRequestQuery(tab.type === "request" ? tab.entityId : null);
	const { data: collections = [] } = useCollectionsQuery();
	// Resolve {{variables}} in the URL so the tab shows the concrete path
	const { resolveString } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});

	let label: React.ReactNode;
	// Plain-text form of the label. Used for the native tooltip, so the full
	// name stays reachable when the text is truncated and nothing animates
	// (pointer-less input, or reduced motion enabled).
	let title: string;
	switch (tab.type) {
		case "welcome":
			label = "Vayu";
			title = "Vayu";
			break;
		case "settings":
			label = "Settings";
			title = "Settings";
			break;
		case "variables":
			label = "Variables";
			title = "Variables";
			break;
		case "request":
			label = request ? (
				<span className="inline-flex items-baseline gap-1.5 min-w-0">
					{/*
					 * Method carries its colour here, as it does in the sidebar -
					 * the same information should not read two different ways. Colour
					 * is also what separates it from the tab's label; without it the
					 * two compete on weight alone. Muted on inactive tabs so a full
					 * strip does not turn into a row of competing colours.
					 */}
					<MethodBadge method={request.method} variant="text" muted={!isActive} />
					<span className="truncate">
						{requestTabTitle(request.name, resolveString(request.url))}
					</span>
				</span>
			) : (
				"Request"
			);
			title = request
				? `${request.method} ${requestTabTitle(request.name, resolveString(request.url))}`
				: "Request";
			break;
		case "collection":
			label = collections.find((c) => c.id === tab.entityId)?.name ?? "Collection";
			title = typeof label === "string" ? label : "Collection";
			break;
		case "dashboard":
			label = "Load Test";
			title = "Load Test";
			break;
		case "run":
			label = "Run";
			title = "Run";
			break;
	}

	return (
		<div
			role="tab"
			aria-selected={isActive}
			tabIndex={rovingTabIndex}
			data-tab-id={tab.id}
			title={title}
			onClick={() => focusTab(tab.id)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					// Space would otherwise scroll the strip's overflow container.
					e.preventDefault();
					focusTab(tab.id);
				}
				// Closing was mouse-only: the X is `tabIndex={-1}` and only appears
				// on hover, and no close shortcut existed anywhere in the app. Delete
				// on the focused tab is the WAI-ARIA pattern for a deletable tab.
				if (e.key === "Delete") {
					e.preventDefault();
					closeTab(tab.id);
				}
			}}
			onAuxClick={(e) => {
				// Middle-click closes, like browsers
				if (e.button === 1) closeTab(tab.id);
			}}
			className={cn(
				// border-t-2 on both states, transparent when inactive, so the
				// active tab's accent stripe does not shift its contents by 2px.
				"group flex h-full min-w-20 max-w-50 shrink cursor-pointer select-none items-center gap-1.5 border-r border-border/40 border-t-2 px-3 text-sm",
				isActive
					? // Accent stripe is the primary signal - it reads identically in
						// both themes, unlike a surface shift, which light mode carries
						// far more weakly (see --tab-active).
						"border-t-primary bg-tab-active text-foreground"
					: "border-t-transparent border-b border-b-border bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground"
			)}
		>
			<TabIcon type={tab.type} />
			<ScrollOnOverflow className="min-w-0 flex-1">{label}</ScrollOnOverflow>
			<span
				role="button"
				tabIndex={-1}
				aria-label="Close tab"
				onClick={(e) => {
					e.stopPropagation();
					closeTab(tab.id);
				}}
				className="shrink-0 rounded-md p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
			>
				<X className="w-3 h-3" />
			</span>
		</div>
	);
}

export function TabStrip() {
	const { openTabs, activeTabId, openTab } = useTabsStore();
	const listRef = useRef<HTMLDivElement>(null);

	/**
	 * Arrow-key navigation across the strip.
	 *
	 * `role="tablist"` is a promise that arrow keys work, and it was not being
	 * kept - the only key handling was Enter/Space on an individual tab. Handled
	 * here by delegation rather than per-tab so the tabs stay ignorant of their
	 * neighbours, and read off the DOM so the order always matches what is
	 * rendered.
	 *
	 * Focus moves without activating (`aria-selected` follows the click, not the
	 * arrow). With a heavy tab like a dashboard in the strip, activate-on-arrow
	 * would fire a mount for every tab you skate past.
	 */
	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
		if (!keys.includes(e.key)) return;

		const tabs = Array.from(
			listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
		);
		if (tabs.length === 0) return;

		const current = tabs.findIndex((el) => el === document.activeElement);
		if (current === -1) return;

		let next = current;
		if (e.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
		if (e.key === "ArrowRight") next = (current + 1) % tabs.length;
		if (e.key === "Home") next = 0;
		if (e.key === "End") next = tabs.length - 1;

		e.preventDefault();
		// Roving tabindex means the destination is currently -1, which is still
		// focusable programmatically; the render that follows activation fixes it.
		tabs[next].tabIndex = 0;
		tabs[next].focus();
	};

	return (
		<div
			ref={listRef}
			role="tablist"
			onKeyDown={onKeyDown}
			className="panel-clip flex h-full min-w-0 items-stretch overflow-x-auto"
			// Tabs and the "+" button stay clickable; the slack to their right is
			// left as a drag region by the parent so the window can be moved.
			style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
		>
			{openTabs.map((tab) => (
				<TabItem key={tab.id} tab={tab} isActive={tab.id === activeTabId} />
			))}
			<button
				onClick={() => openTab({ type: "welcome", entityId: null })}
				aria-label="New tab"
				className="flex w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted/50 hover:text-foreground"
			>
				<Plus className="w-3.5 h-3.5" />
			</button>
		</div>
	);
}

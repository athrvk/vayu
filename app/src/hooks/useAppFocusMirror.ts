/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useRef } from "react";
import { useEnvironmentsQuery } from "@/queries";
import { useSessionStore, useTabsStore, type Tab } from "@/stores";
import { useTabDescriptors } from "@/components/layout/tab-descriptors";

interface AppFocusPayload {
	activeTab: { type: string; entityId: string | null; label: string } | null;
	activeEnvironment: { id: string; name: string } | null;
}

/**
 * What an agent may be told a tab is called.
 *
 * `useTabDescriptors` names an unnamed request and a design or load run by a
 * URL path, and that path is resolved (a request's against the live variables,
 * a run's as sent), so a secret variable used in a URL would reach an agent in
 * a label while Reveal secrets is off. `isPath` marks exactly those labels; they
 * give way to the tab's kind, and every other label is a saved name.
 */
export function focusTabLabel(tab: Tab, descriptor: { label: string; isPath?: boolean }): string {
	if (!descriptor.isPath) return descriptor.label;
	return tab.type === "run" ? "Run" : "Request";
}

/**
 * Keep the main process's copy of what the user has open current, so an MCP
 * client can answer "the request I have open" (issue #2045).
 *
 * Mounted once at the root, beside `useDataFileLocationMirror`. Publishes the
 * whole snapshot, and only when it differs from the last one sent: a label
 * resolving or an unrelated store write re-renders this without changing it.
 * Absent outside Electron, where there is no MCP server to tell.
 */
export function useAppFocusMirror(): void {
	const activeTab = useTabsStore((s) => s.openTabs.find((t) => t.id === s.activeTabId) ?? null);
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const { data: environments } = useEnvironmentsQuery();
	const descriptors = useTabDescriptors(activeTab ? [activeTab] : []);
	const lastSent = useRef<string | null>(null);

	// Not yet named while the environments list loads: an id with no name is
	// less use to an agent than "none", and the name arrives as a second publish.
	const environment = environments?.find((e) => e.id === activeEnvironmentId);
	const focus: AppFocusPayload = {
		activeTab:
			activeTab && descriptors[0]
				? {
						type: activeTab.type,
						entityId: activeTab.entityId,
						label: focusTabLabel(activeTab, descriptors[0]),
					}
				: null,
		activeEnvironment: environment ? { id: environment.id, name: environment.name } : null,
	};

	useEffect(() => {
		const publish = window.electronAPI?.publishAppFocus;
		if (!publish) return;
		const serialized = JSON.stringify(focus);
		if (serialized === lastSent.current) return;
		lastSent.current = serialized;
		publish(focus);
	});
}

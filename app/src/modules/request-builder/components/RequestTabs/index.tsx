/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestTabs Component
 *
 * Tab navigation and content panels for request configuration
 */

import { Tabs, TabsContent, TabsList, TabsTrigger, TabLabel, TabCount } from "@/components/ui";
import { useRequestBuilderContext } from "../../context";
import type { RequestTab, TabInfo } from "../../types";
import InfoPanel from "./panels/InfoPanel";
import ParamsPanel from "./panels/ParamsPanel";
import HeadersPanel from "./panels/HeadersPanel";
import BodyPanel from "./panels/BodyPanel";
import AuthPanel from "./panels/AuthPanel";
import ScriptPanel from "./panels/script/ScriptPanel";
import SettingsPanel from "./panels/SettingsPanel";
import { isRedirectPolicyNonDefault } from "../../utils/request-state";

export default function RequestTabs() {
	const { request, activeTab, setActiveTab } = useRequestBuilderContext();

	// Calculate badges for tabs
	const tabs: TabInfo[] = [
		{
			/*
			 * First, deliberately. A description is the first thing you want to
			 * read about a request and the last thing you find at the end of a
			 * tab row. The badge is `1` for "there is something here" rather than
			 * a count, which is exactly what Body, Auth, Pre-request, Tests and
			 * Settings already do - so it needs no new primitive.
			 */
			id: "info",
			label: "Info",
			badge: request.description?.trim() ? 1 : undefined,
		},
		{
			id: "params",
			label: "Params",
			badge: request.params.filter((p) => p.enabled && p.key.trim()).length || undefined,
		},
		{
			id: "headers",
			label: "Headers",
			badge: request.headers.filter((h) => h.enabled && h.key.trim()).length || undefined,
		},
		{
			id: "body",
			label: "Body",
			badge: request.bodyMode !== "none" ? 1 : undefined,
		},
		{
			id: "auth",
			label: "Auth",
			badge: request.auth.mode !== "none" ? 1 : undefined,
		},
		{
			id: "pre-script",
			label: "Pre-request",
			badge: request.preRequestScript.trim() ? 1 : undefined,
		},
		{
			id: "test-script",
			label: "Tests",
			badge: request.testScript.trim() ? 1 : undefined,
		},
		{
			id: "settings",
			label: "Settings",
			// Badges only when the request departs from the engine defaults, so
			// the tab stays quiet for the requests that never touch it.
			badge: isRedirectPolicyNonDefault(request) ? 1 : undefined,
		},
	];

	return (
		<Tabs
			value={activeTab}
			onValueChange={(v) => setActiveTab(v as RequestTab)}
			className="flex-1 flex flex-col overflow-hidden"
		>
			{/* Tab Headers */}
			<TabsList className="w-full overflow-x-auto overflow-y-hidden flex-nowrap px-1">
				{tabs.map((tab) => (
					<TabsTrigger key={tab.id} value={tab.id}>
						<TabLabel>{tab.label}</TabLabel>
						{tab.badge !== undefined && <TabCount value={tab.badge} />}
					</TabsTrigger>
				))}
			</TabsList>

			{/*
			 * TabsContent per tab, not a plain <div>. Radix derives an
			 * aria-controls id per trigger from its value, so rendering the
			 * content outside the Tabs tree left all six triggers pointing at
			 * panel ids that never existed - a tablist with no reachable panels.
			 * Only the active TabsContent mounts, so <TabContent /> still renders
			 * exactly once and its own switch resolves to that tab.
			 */}
			{tabs.map((tab) => (
				<TabsContent
					key={tab.id}
					value={tab.id}
					className="mt-0 flex-1 overflow-y-auto p-4"
				>
					<TabContent />
				</TabsContent>
			))}
		</Tabs>
	);
}

function TabContent() {
	const { activeTab } = useRequestBuilderContext();

	switch (activeTab) {
		case "info":
			return <InfoPanel />;
		case "params":
			return <ParamsPanel />;
		case "headers":
			return <HeadersPanel />;
		case "body":
			return <BodyPanel />;
		case "auth":
			return <AuthPanel />;
		case "pre-script":
			return <ScriptPanel variant="pre" />;
		case "test-script":
			return <ScriptPanel variant="post" />;
		case "settings":
			return <SettingsPanel />;
		default:
			return null;
	}
}

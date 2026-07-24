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

import { Tabs, TabsContent, TabsList, TabsTrigger, Badge } from "@/components/ui";
import { useRequestBuilderContext } from "../../context";
import type { RequestTab, TabInfo } from "../../types";
import ParamsPanel from "./panels/ParamsPanel";
import HeadersPanel from "./panels/HeadersPanel";
import BodyPanel from "./panels/BodyPanel";
import AuthPanel from "./panels/AuthPanel";
import PreScriptPanel from "./panels/PreScriptPanel";
import TestScriptPanel from "./panels/TestScriptPanel";
import SettingsPanel from "./panels/SettingsPanel";
import { isRedirectPolicyNonDefault } from "../../utils/request-state";

export default function RequestTabs() {
	const { request, activeTab, setActiveTab } = useRequestBuilderContext();

	// Calculate badges for tabs
	const tabs: TabInfo[] = [
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
			<TabsList className="flex w-full justify-start border-b border-border bg-transparent h-auto p-0 overflow-x-auto overflow-y-hidden flex-nowrap">
				{tabs.map((tab) => (
					<TabsTrigger
						key={tab.id}
						value={tab.id}
						className="relative shrink-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2.5 text-sm font-medium"
					>
						{tab.label}
						{tab.badge !== undefined && (
							<Badge
								variant="secondary"
								className="ml-1.5 h-5 min-w-[20px] px-1.5 text-xs"
							>
								{tab.badge}
							</Badge>
						)}
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
		case "params":
			return <ParamsPanel />;
		case "headers":
			return <HeadersPanel />;
		case "body":
			return <BodyPanel />;
		case "auth":
			return <AuthPanel />;
		case "pre-script":
			return <PreScriptPanel />;
		case "test-script":
			return <TestScriptPanel />;
		case "settings":
			return <SettingsPanel />;
		default:
			return null;
	}
}

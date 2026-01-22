
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

import { Tabs, TabsList, TabsTrigger, Badge } from "@/components/ui";
import { useRequestBuilderContext } from "../../context";
import type { RequestTab, TabInfo } from "../../types";
import ParamsPanel from "./panels/ParamsPanel";
import HeadersPanel from "./panels/HeadersPanel";
import BodyPanel from "./panels/BodyPanel";
import AuthPanel from "./panels/AuthPanel";
import PreScriptPanel from "./panels/PreScriptPanel";
import TestScriptPanel from "./panels/TestScriptPanel";

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
			badge: request.authType !== "none" ? 1 : undefined,
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
	];

	return (
		<Tabs
			value={activeTab}
			onValueChange={(v) => setActiveTab(v as RequestTab)}
			className="flex-1 flex flex-col overflow-hidden"
		>
			{/* Tab Headers */}
			<TabsList className="w-full justify-start border-b border-border bg-transparent h-auto p-0">
				{tabs.map((tab) => (
					<TabsTrigger
						key={tab.id}
						value={tab.id}
						className="relative border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2.5 text-sm font-medium"
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

			{/* Tab Content */}
			<div className="flex-1 overflow-y-auto p-4">
				<TabContent />
			</div>
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
		default:
			return null;
	}
}

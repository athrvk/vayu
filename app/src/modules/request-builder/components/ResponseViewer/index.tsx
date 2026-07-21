/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseViewer Component
 *
 * Displays HTTP response with:
 * - Status badges
 * - Response metadata (time, size)
 * - Tabbed view for body/headers/cookies
 * - Body formatting (JSON, HTML, XML, Text, Image, PDF, etc.)
 * - Collapsible headers sections
 * - Console logs separated by pre-scripts and tests
 *
 * Uses shared ResponseBody component for body display with Pretty/Raw/Preview modes.
 */

import { useState } from "react";
import { Copy, Check, Download, Terminal, BarChart3 } from "lucide-react";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	Badge,
	Button,
	Kbd,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import { useRequestBuilderContext } from "../../context";
import { modKey } from "@/lib/platform";
import { useDashboardStore } from "@/stores";
import { ResponseBody as SharedResponseBody } from "@/components/shared/response-viewer";
import { TIMING } from "@/config/timing";
import ResponseHeader from "./ResponseHeader";
import ResponseHeadersTab from "./ResponseHeadersTab";
import ResponseCookies from "./ResponseCookies";
import ResponseTimingTab from "./ResponseTimingTab";
import ConsoleOutput from "./ConsoleOutput";
import TestResults from "./TestResults";
import RawRequestResponse from "./RawRequestResponse";
import ClientErrorView from "./ClientErrorView";

type ResponseTab = "body" | "headers" | "cookies" | "timing" | "console" | "tests" | "raw-request";

export default function ResponseViewer() {
	const { response, isExecuting } = useRequestBuilderContext();
	const { currentRunId, mode: dashboardMode } = useDashboardStore();
	const [activeTab, setActiveTab] = useState<ResponseTab>("body");
	const [copied, setCopied] = useState(false);

	// Check if there's a load test dashboard available
	const hasLoadTestDashboard = !!currentRunId;

	const handleViewLoadTest = () => {
		// View dashboard: would require navigating to dashboard tab
		// This is handled by dashboardMode being "running" which shows the button
	};

	// Loading state
	if (isExecuting) {
		return (
			<div className="flex-1 flex items-center justify-center bg-panel">
				<div className="text-center space-y-4">
					<div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-[vayu-spin_0.7s_linear_infinite] mx-auto" />
					<p className="text-[12px] text-muted-foreground">Sending request…</p>
				</div>
			</div>
		);
	}

	// Empty state
	if (!response) {
		return (
			<div className="flex-1 flex items-center justify-center bg-panel">
				<div className="flex flex-col items-center text-center">
					<svg
						width="64"
						height="64"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="text-primary mb-5"
					>
						<line x1="22" y1="2" x2="11" y2="13" />
						<polygon points="22 2 15 22 11 13 2 9 22 2" />
					</svg>

					<p className="text-[15px] font-medium text-foreground mb-1.5">
						No response yet
					</p>
					<div className="flex items-center justify-center gap-1.5 text-[12px] text-muted-foreground">
						<span>Press</span>
						<Kbd>{modKey}</Kbd>
						<Kbd>↵</Kbd>
						<span>or click Send</span>
					</div>

					{hasLoadTestDashboard && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleViewLoadTest}
							className="mt-6"
						>
							<BarChart3 className="w-4 h-4 mr-2" />
							View Load Test Dashboard
							{dashboardMode === "running" && (
								<Badge variant="default" className="ml-2 text-xs">
									Live
								</Badge>
							)}
						</Button>
					)}
				</div>
			</div>
		);
	}

	// Client-side error state (status === 0 means no server response)
	const isClientError = response.status === 0;

	const handleCopy = async () => {
		await navigator.clipboard.writeText(response.body);
		setCopied(true);
		setTimeout(() => setCopied(false), TIMING.STATUS_RESET_MS);
	};

	const handleDownload = () => {
		const blob = new Blob([response.body], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `response-${Date.now()}.${response.bodyType}`;
		a.click();
		URL.revokeObjectURL(url);
	};

	// Show dedicated error view for client-side errors
	if (isClientError) {
		return (
			<div className="flex-1 flex flex-col bg-card overflow-hidden">
				<ResponseHeader response={response} />
				<ClientErrorView
					errorCode={response.errorCode}
					errorMessage={response.errorMessage}
				/>
			</div>
		);
	}

	return (
		<div className="flex-1 flex flex-col bg-card overflow-hidden">
			{/* Response Header */}
			<ResponseHeader response={response} />

			{/* Response Tabs */}
			<Tabs
				value={activeTab}
				onValueChange={(v) => setActiveTab(v as ResponseTab)}
				className="flex-1 flex flex-col overflow-hidden"
			>
				<div className="flex items-center justify-between border-b border-border px-4 gap-2">
					<TabsList className="flex h-auto p-0 bg-transparent justify-start overflow-x-auto overflow-y-hidden flex-nowrap min-w-0">
						<TabsTrigger
							value="body"
							className="shrink-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
						>
							Body
						</TabsTrigger>
						<TabsTrigger
							value="headers"
							className="shrink-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
						>
							Headers
							<Badge variant="secondary" className="ml-1.5 text-xs">
								{Object.keys(response.headers).length}
							</Badge>
						</TabsTrigger>
						<TabsTrigger
							value="cookies"
							className="shrink-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
						>
							Cookies
						</TabsTrigger>
						{response.timing && (
							<TabsTrigger
								value="timing"
								className="shrink-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
							>
								Timing
							</TabsTrigger>
						)}
						{response.consoleLogs && response.consoleLogs.length > 0 && (
							<TabsTrigger
								value="console"
								className="shrink-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
							>
								<Terminal className="w-4 h-4 mr-1.5" />
								Console
								<Badge variant="secondary" className="ml-1.5 text-xs">
									{response.consoleLogs.length}
								</Badge>
							</TabsTrigger>
						)}
						{response.testResults && response.testResults.length > 0 && (
							<TabsTrigger
								value="tests"
								className="shrink-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
							>
								Tests
								<Badge
									variant={
										response.testResults.every((t) => t.passed)
											? "default"
											: "destructive"
									}
									className="ml-1.5 text-xs"
								>
									{response.testResults.filter((t) => t.passed).length}/
									{response.testResults.length}
								</Badge>
							</TabsTrigger>
						)}
						{response.rawRequest && (
							<TabsTrigger
								value="raw-request"
								className="shrink-0 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
							>
								Raw
							</TabsTrigger>
						)}
					</TabsList>

					{/* Actions */}
					<div className="flex items-center gap-1 shrink-0">
						{/* View Load Test Dashboard button */}
						{hasLoadTestDashboard && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										size="sm"
										variant="outline"
										onClick={handleViewLoadTest}
										className="gap-1.5"
									>
										<BarChart3 className="w-4 h-4" />
										<span className="hidden sm:inline">Load Test</span>
										{dashboardMode === "running" && (
											// Sole indicator that the run is live, so WCAG
											// 1.4.11 applies at 3.0. bg-green-500 measured
											// 2.30 on the card in light mode; the fill
											// token is 4.84 light / 3.57 dark.
											<span className="w-2 h-2 rounded-full bg-status-success-fill animate-pulse" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent>View Load Test Dashboard</TooltipContent>
							</Tooltip>
						)}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="icon"
									variant="ghost"
									onClick={handleCopy}
									aria-label="Copy response"
								>
									{copied ? (
										// Only feedback that the copy happened.
										<Check className="w-4 h-4 text-status-success-text" />
									) : (
										<Copy className="w-4 h-4" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>Copy response</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									size="icon"
									variant="ghost"
									onClick={handleDownload}
									aria-label="Download response"
								>
									<Download className="w-4 h-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Download response</TooltipContent>
						</Tooltip>
					</div>
				</div>

				{/*
				 * TabsContent per tab, not a plain <div>. Radix derives an
				 * aria-controls id per trigger from its value, so rendering the
				 * content outside the Tabs tree left every trigger pointing at a
				 * panel id that never existed. The conditional panels mirror the
				 * conditions on their triggers above, so a tab and its panel are
				 * always rendered together.
				 */}
				<TabsContent value="body" className="mt-0 flex-1 overflow-hidden">
					<SharedResponseBody
						body={response.body}
						bodyRaw={response.bodyRaw}
						headers={response.headers}
						showModeToggle
					/>
				</TabsContent>
				<TabsContent value="headers" className="mt-0 flex-1 overflow-hidden">
					<ResponseHeadersTab response={response} />
				</TabsContent>
				<TabsContent value="cookies" className="mt-0 flex-1 overflow-hidden">
					<ResponseCookies headers={response.headers} />
				</TabsContent>
				{response.timing && (
					<TabsContent value="timing" className="mt-0 flex-1 overflow-hidden">
						<ResponseTimingTab timing={response.timing} />
					</TabsContent>
				)}
				{response.consoleLogs && response.consoleLogs.length > 0 && (
					<TabsContent value="console" className="mt-0 flex-1 overflow-hidden">
						<ConsoleOutput
							logs={response.consoleLogs || []}
							errors={{
								pre: response.preScriptError,
								post: response.postScriptError,
							}}
						/>
					</TabsContent>
				)}
				{response.testResults && response.testResults.length > 0 && (
					<TabsContent value="tests" className="mt-0 flex-1 overflow-hidden">
						<TestResults results={response.testResults || []} />
					</TabsContent>
				)}
				{response.rawRequest && (
					<TabsContent value="raw-request" className="mt-0 flex-1 overflow-hidden">
						<RawRequestResponse
							rawRequest={response.rawRequest || ""}
							response={response}
						/>
					</TabsContent>
				)}
			</Tabs>
		</div>
	);
}

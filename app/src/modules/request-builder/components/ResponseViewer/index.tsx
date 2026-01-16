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
import {
	FileText,
	Copy,
	Check,
	Download,
	Terminal,
	BarChart3,
} from "lucide-react";
import {
	Tabs,
	TabsList,
	TabsTrigger,
	Badge,
	Button,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import { useRequestBuilderContext } from "../../context";
import { useNavigationStore, useDashboardStore } from "@/stores";
import { ResponseBody as SharedResponseBody } from "@/components/shared/response-viewer";
import ResponseHeader from "./ResponseHeader";
import ResponseHeadersTab from "./ResponseHeadersTab";
import ResponseCookies from "./ResponseCookies";
import ConsoleOutput from "./ConsoleOutput";
import TestResults from "./TestResults";
import RawRequestResponse from "./RawRequestResponse";

type ResponseTab = "body" | "headers" | "cookies" | "console" | "tests" | "raw-request";

export default function ResponseViewer() {
	const { response, isExecuting } = useRequestBuilderContext();
	const { navigateToDashboard } = useNavigationStore();
	const { currentRunId, mode: dashboardMode } = useDashboardStore();
	const [activeTab, setActiveTab] = useState<ResponseTab>("body");
	const [copied, setCopied] = useState(false);

	// Check if there's a load test dashboard available
	const hasLoadTestDashboard = !!currentRunId;

	const handleViewLoadTest = () => {
		navigateToDashboard();
	};

	// Loading state
	if (isExecuting) {
		return (
			<div className="flex-1 flex items-center justify-center bg-card">
				<div className="text-center space-y-4">
					<div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
					<p className="text-muted-foreground">Sending request...</p>
				</div>
			</div>
		);
	}

	// Empty state
	if (!response) {
		return (
			<div className="flex-1 flex items-center justify-center bg-card">
				<div className="text-center space-y-4">
					<FileText className="w-12 h-12 mx-auto text-muted-foreground/50" />
					<div className="space-y-2">
						<p className="text-muted-foreground">Response will appear here</p>
						<p className="text-xs text-muted-foreground/70">
							Send a request to see the response
						</p>
					</div>

					{/* Show button to view load test dashboard if available */}
					{hasLoadTestDashboard && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleViewLoadTest}
							className="mt-4"
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

	const handleCopy = async () => {
		await navigator.clipboard.writeText(response.body);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
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
				<div className="flex items-center justify-between border-b border-border px-4">
					<TabsList className="h-auto p-0 bg-transparent">
						<TabsTrigger
							value="body"
							className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
						>
							Body
						</TabsTrigger>
						<TabsTrigger
							value="headers"
							className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
						>
							Headers
							<Badge variant="secondary" className="ml-1.5 text-xs">
								{Object.keys(response.headers).length}
							</Badge>
						</TabsTrigger>
						<TabsTrigger
							value="cookies"
							className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
						>
							Cookies
						</TabsTrigger>
						{response.consoleLogs && response.consoleLogs.length > 0 && (
							<TabsTrigger
								value="console"
								className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
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
								className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
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
								className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
							>
								Raw
							</TabsTrigger>
						)}
					</TabsList>

					{/* Actions */}
					<div className="flex items-center gap-1">
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
											<span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent>View Load Test Dashboard</TooltipContent>
							</Tooltip>
						)}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button size="icon" variant="ghost" onClick={handleCopy}>
									{copied ? (
										<Check className="w-4 h-4 text-green-500" />
									) : (
										<Copy className="w-4 h-4" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>Copy response</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button size="icon" variant="ghost" onClick={handleDownload}>
									<Download className="w-4 h-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Download response</TooltipContent>
						</Tooltip>
					</div>
				</div>

				{/* Tab Content */}
				<div className="flex-1 overflow-hidden">
					{activeTab === "body" && (
						<SharedResponseBody
							body={response.body}
							headers={response.headers}
							showModeToggle
						/>
					)}
					{activeTab === "headers" && <ResponseHeadersTab response={response} />}
					{activeTab === "cookies" && <ResponseCookies headers={response.headers} />}
					{activeTab === "console" && (
						<ConsoleOutput
							logs={response.consoleLogs || []}
							errors={{
								pre: response.preScriptError,
								post: response.postScriptError,
							}}
						/>
					)}
					{activeTab === "tests" && <TestResults results={response.testResults || []} />}
					{activeTab === "raw-request" && (
						<RawRequestResponse
							rawRequest={response.rawRequest || ""}
							response={response}
						/>
					)}
				</div>
			</Tabs>
		</div>
	);
}

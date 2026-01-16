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

import { useState, useMemo } from "react";
import {
	Clock,
	FileText,
	Copy,
	Check,
	Download,
	Terminal,
	CheckCircle,
	XCircle,
	AlertCircle,
	ChevronDown,
	ChevronRight,
	BarChart3,
} from "lucide-react";
import Editor from "@monaco-editor/react";
import {
	Tabs,
	TabsList,
	TabsTrigger,
	Badge,
	Button,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useRequestBuilderContext } from "../../context";
import { useNavigationStore, useDashboardStore } from "@/stores";
import {
	ResponseBody as SharedResponseBody,
	HeadersViewer,
	buildRawResponse,
} from "@/components/shared/response-viewer";

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

// Response Header with status, time, size
interface ResponseHeaderProps {
	response: {
		status: number;
		statusText: string;
		time: number;
		size: number;
	};
}

function ResponseHeader({ response }: ResponseHeaderProps) {
	const statusColor =
		response.status >= 200 && response.status < 300
			? "bg-green-500"
			: response.status >= 300 && response.status < 400
				? "bg-yellow-500"
				: response.status >= 400 && response.status < 500
					? "bg-orange-500"
					: "bg-red-500";

	const formatSize = (bytes: number): string => {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	};

	return (
		<div className="flex items-center gap-4 px-4 py-3 border-b border-border bg-muted/30">
			{/* Status */}
			<Badge className={cn("font-mono", statusColor)}>
				{response.status} {response.statusText}
			</Badge>

			{/* Time */}
			<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
				<Clock className="w-4 h-4" />
				<span>{response.time} ms</span>
			</div>

			{/* Size */}
			<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
				<FileText className="w-4 h-4" />
				<span>{formatSize(response.size)}</span>
			</div>
		</div>
	);
}

// Response Headers table - shows both request and response headers using shared HeadersViewer
interface ResponseHeadersTabProps {
	response: {
		headers: Record<string, string>;
		requestHeaders?: Record<string, string>;
	};
}

function ResponseHeadersTab({ response }: ResponseHeadersTabProps) {
	return (
		<div className="p-4 overflow-auto h-full space-y-4">
			{/* Request Headers */}
			{response.requestHeaders && Object.keys(response.requestHeaders).length > 0 && (
				<HeadersViewer
					headers={response.requestHeaders}
					variant="request"
					defaultOpen={false}
				/>
			)}

			{/* Response Headers */}
			<HeadersViewer headers={response.headers} variant="response" defaultOpen={true} />

			{Object.keys(response.headers).length === 0 && (
				<div className="p-8 text-center text-muted-foreground">No headers in response</div>
			)}
		</div>
	);
}

// Response Cookies
interface ResponseCookiesProps {
	headers: Record<string, string>;
}

function ResponseCookies({ headers }: ResponseCookiesProps) {
	// Extract cookies from Set-Cookie header
	const setCookie = headers["set-cookie"] || headers["Set-Cookie"];

	if (!setCookie) {
		return <div className="p-8 text-center text-muted-foreground">No cookies in response</div>;
	}

	// Parse cookies (simplified)
	const cookies = setCookie.split(",").map((cookie) => {
		const [nameValue, ...attrs] = cookie.split(";");
		const [name, value] = nameValue.split("=");
		return { name: name?.trim(), value: value?.trim(), attrs: attrs.join(";") };
	});

	return (
		<div className="p-4 overflow-auto h-full">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border">
						<th className="text-left py-2 px-3 font-medium text-muted-foreground">
							Name
						</th>
						<th className="text-left py-2 px-3 font-medium text-muted-foreground">
							Value
						</th>
					</tr>
				</thead>
				<tbody>
					{cookies.map((cookie, i) => (
						<tr key={i} className="border-b border-border/50 hover:bg-muted/50">
							<td className="py-2 px-3 font-mono text-primary">{cookie.name}</td>
							<td className="py-2 px-3 font-mono break-all">{cookie.value}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

// Console Output with separation by pre-scripts and tests
interface ConsoleOutputProps {
	logs: string[];
	errors: {
		pre?: string;
		post?: string;
	};
}

interface ParsedLog {
	source: "pre" | "test";
	message: string;
}

function ConsoleOutput({ logs, errors }: ConsoleOutputProps) {
	// Parse logs to separate by source
	// Backend prefixes pre-script logs with "[pre] "
	const parsedLogs = useMemo((): ParsedLog[] => {
		return logs.map((log) => {
			if (log.startsWith("[pre] ")) {
				return { source: "pre", message: log.substring(6) };
			}
			return { source: "test", message: log };
		});
	}, [logs]);

	const preLogs = parsedLogs.filter((l) => l.source === "pre");
	const testLogs = parsedLogs.filter((l) => l.source === "test");

	const [preLogsOpen, setPreLogsOpen] = useState(true);
	const [testLogsOpen, setTestLogsOpen] = useState(true);

	return (
		<div className="p-4 overflow-auto h-full space-y-4">
			{/* Script Errors */}
			{(errors.pre || errors.post) && (
				<div className="space-y-2">
					{errors.pre && (
						<div className="p-3 bg-red-500/10 border border-red-500/20 rounded-md">
							<div className="flex items-start gap-2">
								<AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
								<div className="flex-1 min-w-0">
									<p className="text-sm font-semibold text-red-500">
										Pre-request Script Error
									</p>
									<pre className="text-sm text-red-400 mt-1 font-mono whitespace-pre-wrap break-words overflow-x-auto">
										{errors.pre}
									</pre>
								</div>
							</div>
						</div>
					)}
					{errors.post && (
						<div className="p-3 bg-red-500/10 border border-red-500/20 rounded-md">
							<div className="flex items-start gap-2">
								<AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
								<div className="flex-1 min-w-0">
									<p className="text-sm font-semibold text-red-500">
										Test Script Error
									</p>
									<pre className="text-sm text-red-400 mt-1 font-mono whitespace-pre-wrap break-words overflow-x-auto">
										{errors.post}
									</pre>
								</div>
							</div>
						</div>
					)}
				</div>
			)}

			{/* Console Logs */}
			{logs.length === 0 ? (
				<div className="p-8 text-center text-muted-foreground">No console output</div>
			) : (
				<div className="space-y-3">
					{/* Pre-request Script Logs */}
					{preLogs.length > 0 && (
						<Collapsible open={preLogsOpen} onOpenChange={setPreLogsOpen}>
							<CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
								<div className="flex items-center justify-center w-5 h-5 rounded bg-blue-500/20 group-hover:bg-blue-500/30 transition-colors">
									{preLogsOpen ? (
										<ChevronDown className="w-4 h-4 text-blue-500" />
									) : (
										<ChevronRight className="w-4 h-4 text-blue-500" />
									)}
								</div>
								<h3 className="text-sm font-medium text-blue-500">
									Pre-request Script
								</h3>
								<Badge
									variant="outline"
									className="ml-auto text-xs border-blue-500/30 text-blue-500"
								>
									{preLogs.length} log{preLogs.length !== 1 ? "s" : ""}
								</Badge>
							</CollapsibleTrigger>
							<CollapsibleContent className="mt-2">
								<div className="bg-zinc-900 rounded-md p-3 font-mono text-sm space-y-1 border border-zinc-800">
									{preLogs.map((log, i) => (
										<div key={i} className="flex items-start gap-2">
											<Terminal className="w-4 h-4 text-blue-500/70 mt-0.5 flex-shrink-0" />
											<pre className="text-zinc-300 whitespace-pre-wrap break-words flex-1 min-w-0">
												{log.message}
											</pre>
										</div>
									))}
								</div>
							</CollapsibleContent>
						</Collapsible>
					)}

					{/* Test Script Logs */}
					{testLogs.length > 0 && (
						<Collapsible open={testLogsOpen} onOpenChange={setTestLogsOpen}>
							<CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
								<div className="flex items-center justify-center w-5 h-5 rounded bg-green-500/20 group-hover:bg-green-500/30 transition-colors">
									{testLogsOpen ? (
										<ChevronDown className="w-4 h-4 text-green-500" />
									) : (
										<ChevronRight className="w-4 h-4 text-green-500" />
									)}
								</div>
								<h3 className="text-sm font-medium text-green-500">Test Script</h3>
								<Badge
									variant="outline"
									className="ml-auto text-xs border-green-500/30 text-green-500"
								>
									{testLogs.length} log{testLogs.length !== 1 ? "s" : ""}
								</Badge>
							</CollapsibleTrigger>
							<CollapsibleContent className="mt-2">
								<div className="bg-zinc-900 rounded-md p-3 font-mono text-sm space-y-1 border border-zinc-800">
									{testLogs.map((log, i) => (
										<div key={i} className="flex items-start gap-2">
											<Terminal className="w-4 h-4 text-green-500/70 mt-0.5 flex-shrink-0" />
											<pre className="text-zinc-300 whitespace-pre-wrap break-words flex-1 min-w-0">
												{log.message}
											</pre>
										</div>
									))}
								</div>
							</CollapsibleContent>
						</Collapsible>
					)}
				</div>
			)}
		</div>
	);
}

// Raw Request & Response Viewer (similar to Postman)
interface RawRequestResponseProps {
	rawRequest: string;
	response: {
		status: number;
		statusText: string;
		headers: Record<string, string>;
		body: string;
	};
}

function RawRequestResponse({ rawRequest, response }: RawRequestResponseProps) {
	// Use shared utility to build raw response
	const rawResponse = buildRawResponse(
		response.status,
		response.statusText,
		response.headers,
		response.body
	);

	// Combine request and response with a separator
	const combinedRaw = rawRequest
		? `${rawRequest}\n\n${"─".repeat(60)}\n\n${rawResponse}`
		: rawResponse;

	if (!rawRequest && !response) {
		return <div className="p-8 text-center text-muted-foreground">No raw data available</div>;
	}

	return (
		<Editor
			height="100%"
			language="http"
			value={combinedRaw}
			theme="vs-dark"
			options={{
				readOnly: true,
				minimap: { enabled: false },
				fontSize: 13,
				lineNumbers: "on",
				scrollBeyondLastLine: false,
				wordWrap: "on",
				automaticLayout: true,
				folding: false,
			}}
		/>
	);
}

// Test Results
interface TestResultsProps {
	results: Array<{ name: string; passed: boolean; error?: string }>;
}

function TestResults({ results }: TestResultsProps) {
	const passedCount = results.filter((t) => t.passed).length;
	const failedCount = results.length - passedCount;

	return (
		<div className="p-4 overflow-auto h-full">
			{/* Summary */}
			<div className="mb-4 flex items-center gap-4">
				<Badge variant={failedCount === 0 ? "default" : "destructive"} className="text-sm">
					{passedCount} passed, {failedCount} failed
				</Badge>
			</div>

			{/* Test List */}
			<div className="space-y-2">
				{results.map((test, i) => (
					<div
						key={i}
						className={cn(
							"p-3 rounded-md border",
							test.passed
								? "bg-green-500/10 border-green-500/20"
								: "bg-red-500/10 border-red-500/20"
						)}
					>
						<div className="flex items-start gap-2">
							{test.passed ? (
								<CheckCircle className="w-5 h-5 text-green-500 mt-0.5 flex-shrink-0" />
							) : (
								<XCircle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
							)}
							<div className="flex-1">
								<p
									className={cn(
										"text-sm font-medium",
										test.passed ? "text-green-500" : "text-red-500"
									)}
								>
									{test.name}
								</p>
								{test.error && (
									<p className="text-sm text-red-400 mt-1 font-mono">
										{test.error}
									</p>
								)}
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

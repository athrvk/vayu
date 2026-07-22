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
import { Terminal } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger, Badge, Kbd } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useRequestBuilderContext } from "../../context";
import { modKey } from "@/lib/platform";
import {
	ResponseBody as SharedResponseBody,
	ResponseStatusBar,
	ResponseActions,
	ResponseHeadersPanel,
	RESPONSE_TAB_TRIGGER,
} from "@/components/shared/response-viewer";
import ResponseCookies from "./ResponseCookies";
import ResponseTimingTab from "./ResponseTimingTab";
import ConsoleOutput from "./ConsoleOutput";
import TestResults from "./TestResults";
import RawRequestResponse from "./RawRequestResponse";
import ClientErrorView from "./ClientErrorView";

type ResponseTab = "body" | "headers" | "cookies" | "timing" | "console" | "tests" | "raw-request";

export default function ResponseViewer() {
	const { response, isExecuting } = useRequestBuilderContext();
	const [activeTab, setActiveTab] = useState<ResponseTab>("body");

	// Loading state
	if (isExecuting) {
		return (
			<div className="flex-1 flex items-center justify-center bg-panel">
				<div className="text-center space-y-4">
					<div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-[vayu-spin_0.7s_linear_infinite] mx-auto" />
					<p className="text-xs text-muted-foreground">Sending request…</p>
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

					<p className="text-md font-medium text-foreground mb-1.5">No response yet</p>
					<div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
						<span>Press</span>
						<Kbd>{modKey}</Kbd>
						<Kbd>↵</Kbd>
						<span>or click Send</span>
					</div>
				</div>
			</div>
		);
	}

	// Client-side error state (status === 0 means no server response)
	const isClientError = response.status === 0;

	// Show dedicated error view for client-side errors
	if (isClientError) {
		return (
			<div className="flex-1 flex flex-col surface-card overflow-hidden">
				<ResponseStatusBar
					status={response.status}
					statusText={response.statusText}
					time={response.time}
					size={response.size}
					restoredFrom={response.restoredFrom}
				/>
				<ClientErrorView
					errorCode={response.errorCode}
					errorMessage={response.errorMessage}
				/>
			</div>
		);
	}

	return (
		<div className="flex-1 flex flex-col surface-card overflow-hidden">
			{/* Response Header */}
			<ResponseStatusBar
				status={response.status}
				statusText={response.statusText}
				time={response.time}
				size={response.size}
				restoredFrom={response.restoredFrom}
			/>

			{/* Response Tabs */}
			<Tabs
				value={activeTab}
				onValueChange={(v) => setActiveTab(v as ResponseTab)}
				className="flex-1 flex flex-col overflow-hidden"
			>
				{/* `border-rule`, and the `surface-card` root above is what gives it a
				    value. Every divider in this pane says the same thing and the
				    surface decides what it resolves to - `--border` in light, where it
				    measures 1.304, and `--border-strong` in dark, where `--border`
				    would be 1.003 (the same colour as the card, which is why the tab
				    strip used to float free of the content). See index.css,
				    "Surfaces, and the rule colour that reads on each". */}
				<div className="flex items-center justify-between border-b border-rule px-4 gap-2">
					<TabsList className="flex h-auto p-0 bg-transparent justify-start overflow-x-auto overflow-y-hidden flex-nowrap min-w-0">
						<TabsTrigger value="body" className={cn("shrink-0", RESPONSE_TAB_TRIGGER)}>
							Body
						</TabsTrigger>
						<TabsTrigger
							value="headers"
							className={cn("shrink-0", RESPONSE_TAB_TRIGGER)}
						>
							Headers
							<Badge variant="secondary" className="ml-1.5 text-xs">
								{Object.keys(response.headers).length}
							</Badge>
						</TabsTrigger>
						<TabsTrigger
							value="cookies"
							className={cn("shrink-0", RESPONSE_TAB_TRIGGER)}
						>
							Cookies
						</TabsTrigger>
						{response.timing && (
							<TabsTrigger
								value="timing"
								className={cn("shrink-0", RESPONSE_TAB_TRIGGER)}
							>
								Timing
							</TabsTrigger>
						)}
						{response.consoleLogs && response.consoleLogs.length > 0 && (
							<TabsTrigger
								value="console"
								className={cn("shrink-0", RESPONSE_TAB_TRIGGER)}
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
								className={cn("shrink-0", RESPONSE_TAB_TRIGGER)}
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
								className={cn("shrink-0", RESPONSE_TAB_TRIGGER)}
							>
								Raw
							</TabsTrigger>
						)}
					</TabsList>

					{/* `response.bodyType` names the download; the history viewer has no
					    such field and keeps `.txt`. Passed rather than inferred. */}
					<ResponseActions content={response.body} fileExtension={response.bodyType} />
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
					<ResponseHeadersPanel
						requestHeaders={response.requestHeaders}
						responseHeaders={response.headers}
					/>
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

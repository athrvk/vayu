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
	formatSize,
} from "@/components/shared/response-viewer";
import { Callout } from "@/components/shared";
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

	// Which of the four conditional tabs are present on *this* response. The
	// engine emits `timing`/`rawRequest` on every live execute but omits them
	// from some restored traces, and `consoleLogs`/`testResults` only when a
	// script produced them - so the tab set shrinks as you switch responses.
	const hasTiming = !!response.timing;
	const hasConsoleLogs = !!response.consoleLogs && response.consoleLogs.length > 0;
	// A failing pre/post-request script must surface even when it threw before
	// logging anything - a typo or ReferenceError produces `preScriptError` with
	// empty `consoleLogs`, so gating the Console tab on logs alone hid the error
	// behind a normal-looking 200 (issue #111). Show the tab when either exists;
	// `ConsoleOutput` already renders the error cards above the (empty) log area.
	const hasScriptError = !!response.preScriptError || !!response.postScriptError;
	const hasConsole = hasConsoleLogs || hasScriptError;
	const hasTests = !!response.testResults && response.testResults.length > 0;
	const hasRaw = !!response.rawRequest;

	// The tabs actually rendered below, in trigger order. Both the triggers and
	// their panels key off the same `has*` flags, so this list is exactly the
	// set Radix has to select from.
	const availableTabs: ResponseTab[] = [
		"body",
		"headers",
		"cookies",
		...(hasTiming ? (["timing"] as const) : []),
		...(hasConsole ? (["console"] as const) : []),
		...(hasTests ? (["tests"] as const) : []),
		...(hasRaw ? (["raw-request"] as const) : []),
	];

	// Clamp the selection to a tab that still renders. `activeTab` is local state
	// that survives a response change, so a tab clicked on one response can name
	// a trigger the next response no longer draws - leaving the controlled Tabs
	// root with nothing to select and a blank pane (issue #59). Falling back to
	// `body`, which is always present, keeps a tab selected and the body shown.
	const effectiveTab = availableTabs.includes(activeTab) ? activeTab : "body";

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
				value={effectiveTab}
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
						{hasTiming && (
							<TabsTrigger
								value="timing"
								className={cn("shrink-0", RESPONSE_TAB_TRIGGER)}
							>
								Timing
							</TabsTrigger>
						)}
						{hasConsole && (
							<TabsTrigger
								value="console"
								className={cn("shrink-0", RESPONSE_TAB_TRIGGER)}
							>
								<Terminal className="w-4 h-4 mr-1.5" />
								Console
								{hasConsoleLogs ? (
									<Badge variant="secondary" className="ml-1.5 text-xs">
										{response.consoleLogs!.length}
									</Badge>
								) : (
									// Script error with no logs: flag the failure instead
									// of a misleading "0" log count (issue #111).
									<Badge variant="destructive" className="ml-1.5 text-xs">
										Error
									</Badge>
								)}
							</TabsTrigger>
						)}
						{hasTests && (
							<TabsTrigger
								value="tests"
								className={cn("shrink-0", RESPONSE_TAB_TRIGGER)}
							>
								Tests
								<Badge
									variant={
										response.testResults!.every((t) => t.passed)
											? "default"
											: "destructive"
									}
									className="ml-1.5 text-xs"
								>
									{response.testResults!.filter((t) => t.passed).length}/
									{response.testResults!.length}
								</Badge>
							</TabsTrigger>
						)}
						{hasRaw && (
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
					<div className="flex flex-col h-full">
						{/*
						 * The engine caps a stored trace body at `maxTraceBodyBytes`,
						 * so a response restored from a run (cold start, or a design
						 * run opened from History) may hold only the stored slice.
						 * Say so, and how to get the whole thing back.
						 */}
						{response.bodyTruncated && (
							<div className="px-4 pt-3 shrink-0">
								<Callout severity="warning" title="Body truncated for storage">
									Only the first {formatSize(response.body.length)} of{" "}
									{formatSize(response.bodyBytes ?? response.body.length)} was
									kept. Re-send the request to view the full response.
								</Callout>
							</div>
						)}
						<div className="flex-1 min-h-0">
							<SharedResponseBody
								body={response.body}
								bodyRaw={response.bodyRaw}
								headers={response.headers}
								showModeToggle
							/>
						</div>
					</div>
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
				{hasTiming && (
					<TabsContent value="timing" className="mt-0 flex-1 overflow-hidden">
						<ResponseTimingTab timing={response.timing!} />
					</TabsContent>
				)}
				{hasConsole && (
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
				{hasTests && (
					<TabsContent value="tests" className="mt-0 flex-1 overflow-hidden">
						<TestResults results={response.testResults || []} />
					</TabsContent>
				)}
				{hasRaw && (
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

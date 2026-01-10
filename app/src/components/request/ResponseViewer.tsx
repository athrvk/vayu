import { useState } from "react";
import {
	CheckCircle,
	XCircle,
	Clock,
	Database,
	FileText,
	List,
	Activity,
	Terminal,
} from "lucide-react";
import { formatBytes, formatDuration, getStatusColor } from "@/utils";
import { ErrorHints, ErrorStatusCodes } from "@/constants/error-codes";
import type { SanityResult } from "@/types";

interface ResponseViewerProps {
	response: SanityResult;
}

type ResponseTab = "body" | "headers" | "timing" | "tests" | "console";

export default function ResponseViewer({ response }: ResponseViewerProps) {
	const [activeTab, setActiveTab] = useState<ResponseTab>("body");

	if (!response.status) {
		return (
			<div className="p-6">
				{response.error ? (
					<div className="border border-red-200 rounded-lg p-4 bg-red-50">
						<div className="flex items-start gap-3">
							<XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
							<div className="flex-1">
								<h3 className="text-sm font-semibold text-red-900 mb-1">
									Request Failed
								</h3>
								<p className="text-sm text-red-800 mb-3">{response.error}</p>
								{(response as any).errorCode && (
									<div className="flex items-center gap-2">
										<span className="text-xs font-mono bg-red-100 text-red-700 px-2 py-1 rounded">
											{(response as any).errorCode}
										</span>
										{(response as any).statusCode && (
											<span className="text-xs text-red-600">
												HTTP {(response as any).statusCode}
											</span>
										)}
									</div>
								)}
								{(response as any).errorCode && ErrorHints[(response as any).errorCode as keyof typeof ErrorHints] && (
									<p className="text-xs text-red-700 mt-2">
										{ErrorHints[(response as any).errorCode as keyof typeof ErrorHints]}
									</p>
								)}
							</div>
						</div>
					</div>
				) : (
						<div className="text-center py-8 text-gray-500">
							<p>No response data</p>
						</div>
				)}
			</div>
		);
	}

	const { testResults } = response;
	const hasTests = testResults && testResults.length > 0;
	const hasConsoleLogs =
		response.consoleLogs && response.consoleLogs.length > 0;

	const tabs = [
		{ id: "body" as ResponseTab, label: "Body", icon: FileText },
		{
			id: "headers" as ResponseTab,
			label: "Headers",
			icon: List,
			count: Object.keys(response.headers).length,
		},
		{ id: "timing" as ResponseTab, label: "Timing", icon: Activity },
		...(hasTests
			? [
					{
						id: "tests" as ResponseTab,
						label: "Tests",
						icon: CheckCircle,
					count: testResults.length,
					},
			  ]
			: []),
		...(hasConsoleLogs
			? [
					{
						id: "console" as ResponseTab,
						label: "Console",
						icon: Terminal,
					count: response.consoleLogs!.length,
					},
			  ]
			: []),
	];

	return (
		<div className="h-full flex flex-col overflow-hidden bg-white">
			{/* Response Header - Compact Status Bar */}
			<div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-4">
						<div className="flex items-center gap-2">
							<span
								className={`text-lg font-bold ${getStatusColor(
									response.status
								)}`}
							>
								{response.status}
							</span>
							<span className="text-sm text-gray-600">
								{response.statusText}
							</span>
						</div>
						<div className="h-4 w-px bg-gray-300" />
						<div className="flex items-center gap-1 text-sm text-gray-600">
							<Clock className="w-3.5 h-3.5" />
							<span className="font-medium">
								{formatDuration(response.timing.total)}
							</span>
						</div>
						<div className="flex items-center gap-1 text-sm text-gray-600">
							<Database className="w-3.5 h-3.5" />
							<span className="font-medium">
								{formatBytes(response.bodySize)}
							</span>
						</div>
					</div>

					{/* Quick Test Summary */}
					{hasTests && (
						<div className="flex items-center gap-2 text-sm">
							<span className="text-gray-600">Tests:</span>
							<span className="text-green-600 font-medium">
								{testResults.filter((t) => t.passed).length} passed
							</span>
							{testResults.filter((t) => !t.passed).length > 0 && (
								<>
									<span className="text-gray-400">/</span>
									<span className="text-red-600 font-medium">
										{testResults.filter((t) => !t.passed).length} failed
									</span>
								</>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Tabs Navigation */}
			{/* Script Errors Banner */}
			{(response.preScriptError || response.postScriptError) && (
				<div className="px-4 py-2 bg-amber-50 border-b border-amber-200">
					<div className="flex items-start gap-2">
						<XCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
						<div className="text-sm">
							{response.preScriptError && (
								<div className="text-amber-800">
									<span className="font-medium">Pre-request script error:</span>{" "}
									{response.preScriptError}
								</div>
							)}
							{response.postScriptError && (
								<div className="text-amber-800">
									<span className="font-medium">Post-request script error:</span>{" "}
									{response.postScriptError}
								</div>
							)}
						</div>
					</div>
				</div>
			)}

			{/* Tab Bar */}
			<div className="border-b border-gray-200">
				<div className="flex">
					{tabs.map((tab) => (
						<button
							key={tab.id}
							onClick={() => setActiveTab(tab.id)}
							className={`
flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors
${
	activeTab === tab.id
		? "border-blue-500 text-blue-600 bg-blue-50"
		: "border-transparent text-gray-600 hover:text-gray-800 hover:bg-gray-50"
}
`}
						>
							<tab.icon className="w-4 h-4" />
							<span>{tab.label}</span>
							{tab.count !== undefined && (
								<span
									className={`
text-xs px-1.5 py-0.5 rounded-full
${
	activeTab === tab.id
		? "bg-blue-100 text-blue-700"
		: "bg-gray-200 text-gray-600"
}
`}
								>
									{tab.count}
								</span>
							)}
						</button>
					))}
				</div>
			</div>

			{/* Tab Content */}
			<div className="flex-1 overflow-auto">
				{/* Body Tab */}
				{activeTab === "body" && (
					<div className="p-4">
						<div className="mb-2 flex items-center justify-between">
							<span className="text-xs text-gray-500">
								{typeof response.body === "object" ? "JSON" : "Plain Text"}{" "}
								{formatBytes(response.bodySize)}
							</span>
						</div>
						<pre className="p-4 bg-gray-900 text-gray-100 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed">
							{typeof response.body === "object"
								? JSON.stringify(response.body, null, 2)
								: response.body}
						</pre>
					</div>
				)}

				{/* Headers Tab */}
				{activeTab === "headers" && (
					<div className="p-4">
						<div className="space-y-0 border border-gray-200 rounded-lg overflow-hidden">
							{Object.entries(response.headers).map(([key, value], index) => (
								<div
									key={key}
									className={`flex text-sm ${
										index % 2 === 0 ? "bg-gray-50" : "bg-white"
									}`}
								>
									<div className="w-1/3 px-4 py-2.5 font-medium text-gray-700 border-r border-gray-200">
										{key}
									</div>
									<div className="flex-1 px-4 py-2.5 text-gray-600 font-mono text-xs break-all">
										{value}
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Timing Tab */}
				{activeTab === "timing" && (
					<div className="p-4">
						<div className="space-y-4">
							{/* Total Time Banner */}
							<div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white p-4 rounded-lg">
								<div className="text-sm font-medium mb-1">
									Total Request Time
								</div>
								<div className="text-3xl font-bold">
									{formatDuration(response.timing.total)}
								</div>
							</div>

							{/* Timing Breakdown */}
							<div className="space-y-2">
								<h3 className="text-sm font-semibold text-gray-700 mb-3">
									Breakdown
								</h3>
								{[
									{
										label: "DNS Lookup",
										value: response.timing.dns,
										color: "bg-purple-500",
									},
									{
										label: "TCP Connection",
										value: response.timing.connect,
										color: "bg-blue-500",
									},
									{
										label: "TLS Handshake",
										value: response.timing.tls,
										color: "bg-indigo-500",
									},
									{
										label: "Time to First Byte",
										value: response.timing.firstByte,
										color: "bg-green-500",
									},
									{
										label: "Content Download",
										value: response.timing.download,
										color: "bg-orange-500",
									},
								].map((timing) => {
									const percentage =
										(timing.value / response.timing.total) * 100;
									return (
										<div key={timing.label} className="space-y-1">
											<div className="flex justify-between items-center text-sm">
												<span className="text-gray-700">{timing.label}</span>
												<span className="font-mono font-medium text-gray-900">
													{formatDuration(timing.value)}
													<span className="text-xs text-gray-500 ml-2">
														({percentage.toFixed(1)}%)
													</span>
												</span>
											</div>
											<div className="h-2 bg-gray-100 rounded-full overflow-hidden">
												<div
													className={`h-full ${timing.color} transition-all duration-300`}
													style={{ width: `${percentage}%` }}
												/>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					</div>
				)}

				{/* Tests Tab */}
				{activeTab === "tests" && hasTests && (
					<div className="p-4">
						<div className="space-y-2">
							{testResults.map((test, index) => (
								<div
									key={index}
									className={`
p-4 rounded-lg border-l-4
${test.passed ? "bg-green-50 border-green-500" : "bg-red-50 border-red-500"}
`}
								>
									<div className="flex items-start gap-3">
										{test.passed ? (
											<CheckCircle className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
										) : (
											<XCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
										)}
										<div className="flex-1 min-w-0">
											<div
												className={`font-medium ${
													test.passed ? "text-green-900" : "text-red-900"
												}`}
											>
												{test.name}
											</div>
											{test.error && (
												<div className="mt-2 text-sm text-red-700 font-mono bg-red-100 p-2 rounded">
													{test.error}
												</div>
											)}
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Console Tab */}
				{activeTab === "console" && hasConsoleLogs && (
					<div className="p-4">
						<div className="bg-gray-900 rounded-lg p-4 font-mono text-sm">
							{response.consoleLogs!.map((log, index) => (
								<div
									key={index}
									className="text-green-400 py-1 border-b border-gray-800 last:border-0"
								>
									<span className="text-gray-500 mr-3">{index + 1}</span>
									{log}
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}


/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Error Boundary
 *
 * React Error Boundary component to catch and display errors in the component tree.
 */

import { Component, ErrorInfo, ReactNode } from "react";
import { AlertCircle, RefreshCw, Home, Copy, Check } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { logError } from "./error-logger";

// App version from package.json (injected by Vite via vite.config.ts)
const APP_VERSION = typeof __VAYU_VERSION__ !== "undefined" ? __VAYU_VERSION__ : "0.1.1";

/**
 * Extract Electron/Chrome versions from user agent
 */
function getElectronInfo(): { electron: string; chrome: string } {
	const ua = navigator.userAgent;
	const electronMatch = ua.match(/Electron\/(\d+\.\d+\.\d+)/);
	const chromeMatch = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
	return {
		electron: electronMatch?.[1] ?? "N/A",
		chrome: chromeMatch?.[1] ?? "N/A",
	};
}

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
	onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
	hasError: boolean;
	error: Error | null;
	errorInfo: ErrorInfo | null;
	copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			errorInfo: null,
			copied: false,
		};
	}

	static getDerivedStateFromError(error: Error): Partial<State> {
		return {
			hasError: true,
			error,
		};
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		// Store errorInfo for later use
		this.setState({ errorInfo });

		// Log error
		logError(error, "high", {
			component: "ErrorBoundary",
			action: "componentDidCatch",
			metadata: {
				componentStack: errorInfo.componentStack,
			},
		});

		// Call custom error handler if provided
		if (this.props.onError) {
			this.props.onError(error, errorInfo);
		}
	}

	handleReset = () => {
		this.setState({
			hasError: false,
			error: null,
			errorInfo: null,
			copied: false,
		});
	};

	handleReload = () => {
		window.location.reload();
	};

	/**
	 * Generate comprehensive error report for copying
	 */
	generateErrorReport = (): string => {
		const { error, errorInfo } = this.state;
		const timestamp = new Date().toISOString();
		const electronInfo = getElectronInfo();

		// Gather system info
		const systemInfo = {
			appVersion: APP_VERSION,
			platform: navigator.platform,
			userAgent: navigator.userAgent,
			language: navigator.language,
			url: window.location.href,
			timestamp,
			// Electron info extracted from user agent
			...electronInfo,
		};

		const sections = [
			"=".repeat(60),
			"VAYU ERROR REPORT",
			"=".repeat(60),
			"",
			"## Timestamp",
			timestamp,
			"",
			"## App Version",
			APP_VERSION,
			"",
			"## Environment",
			`Platform: ${systemInfo.platform}`,
			`Language: ${systemInfo.language}`,
			`URL: ${systemInfo.url}`,
			`Electron: ${systemInfo.electron}`,
			`Chrome: ${systemInfo.chrome}`,
			"",
			"## User Agent",
			systemInfo.userAgent,
			"",
			"## Error Message",
			error?.message ?? "Unknown error",
			"",
			"## Error Name",
			error?.name ?? "Error",
			"",
			"## Stack Trace",
			error?.stack ?? "No stack trace available",
			"",
			"## Component Stack",
			errorInfo?.componentStack?.trim() ?? "No component stack available",
			"",
			"=".repeat(60),
		];

		return sections.join("\n");
	};

	handleCopyError = async () => {
		const errorReport = this.generateErrorReport();

		try {
			await navigator.clipboard.writeText(errorReport);
			this.setState({ copied: true });

			// Reset copied state after 2 seconds
			setTimeout(() => {
				this.setState({ copied: false });
			}, 2000);
		} catch (err) {
			console.error("Failed to copy error report:", err);
		}
	};

	render() {
		if (this.state.hasError) {
			// Use custom fallback if provided
			if (this.props.fallback) {
				return this.props.fallback;
			}

			const { copied } = this.state;

			// Default error UI
			return (
				<div className="flex items-center justify-center min-h-screen p-4 bg-background">
					<Card className="w-full max-w-lg">
						<CardHeader>
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<AlertCircle className="w-6 h-6 text-destructive" />
									<CardTitle>Something went wrong</CardTitle>
								</div>
								<span className="text-xs text-muted-foreground">
									v{APP_VERSION}
								</span>
							</div>
						</CardHeader>
						<CardContent className="space-y-4">
							<p className="text-sm text-muted-foreground">
								{this.state.error?.message || "An unexpected error occurred"}
							</p>

							{this.state.error?.stack && (
								<details className="text-xs">
									<summary className="cursor-pointer text-muted-foreground mb-2">
										Error details{" "}
										{process.env.NODE_ENV === "development" && "(dev only)"}
									</summary>
									<pre className="p-3 bg-muted overflow-auto max-h-48 text-muted-foreground whitespace-pre-wrap break-words">
										{this.state.error.stack}
									</pre>
								</details>
							)}

							<div className="flex gap-2">
								<Button
									variant="outline"
									onClick={this.handleCopyError}
									className="flex-1"
									disabled={copied}
								>
									{copied ? (
										<>
											<Check className="w-4 h-4 mr-2 text-green-500" />
											Copied!
										</>
									) : (
										<>
											<Copy className="w-4 h-4 mr-2" />
											Copy Error Info
										</>
									)}
								</Button>
							</div>

							<div className="flex gap-2">
								<Button
									variant="outline"
									onClick={this.handleReset}
									className="flex-1"
								>
									<RefreshCw className="w-4 h-4 mr-2" />
									Try Again
								</Button>
								<Button
									variant="default"
									onClick={this.handleReload}
									className="flex-1"
								>
									<Home className="w-4 h-4 mr-2" />
									Reload App
								</Button>
							</div>

							<p className="text-xs text-muted-foreground text-center">
								If this issue persists, please copy the error info and report it.
							</p>
						</CardContent>
					</Card>
				</div>
			);
		}

		return this.props.children;
	}
}

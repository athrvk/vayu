/**
 * Error Boundary
 *
 * React Error Boundary component to catch and display errors in the component tree.
 */

import { Component, ErrorInfo, ReactNode } from "react";
import { AlertCircle, RefreshCw, Home } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { logError } from "./error-logger";

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
	onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
	hasError: boolean;
	error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
		};
	}

	static getDerivedStateFromError(error: Error): State {
		return {
			hasError: true,
			error,
		};
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
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
		});
	};

	handleReload = () => {
		window.location.reload();
	};

	render() {
		if (this.state.hasError) {
			// Use custom fallback if provided
			if (this.props.fallback) {
				return this.props.fallback;
			}

			// Default error UI
			return (
				<div className="flex items-center justify-center min-h-screen p-4 bg-background">
					<Card className="w-full max-w-md">
						<CardHeader>
							<div className="flex items-center gap-3">
								<AlertCircle className="w-6 h-6 text-destructive" />
								<CardTitle>Something went wrong</CardTitle>
							</div>
						</CardHeader>
						<CardContent className="space-y-4">
							<p className="text-sm text-muted-foreground">
								{this.state.error?.message || "An unexpected error occurred"}
							</p>

							{process.env.NODE_ENV === "development" && this.state.error?.stack && (
								<details className="text-xs">
									<summary className="cursor-pointer text-muted-foreground mb-2">
										Error details (dev only)
									</summary>
									<pre className="p-3 bg-muted rounded-md overflow-auto max-h-48 text-muted-foreground">
										{this.state.error.stack}
									</pre>
								</details>
							)}

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
						</CardContent>
					</Card>
				</div>
			);
		}

		return this.props.children;
	}
}

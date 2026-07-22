/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ClientErrorView Component
 *
 * Displayed when a request fails before reaching the server (status === 0).
 * Shows appropriate icon, error message, and helpful hints based on error type.
 */

import {
	AlertCircle,
	WifiOff,
	Clock,
	ShieldX,
	Link2Off,
	ServerOff,
	Lightbulb,
	type LucideIcon,
} from "lucide-react";

interface ErrorIconDisplayProps {
	icon: LucideIcon;
	className: string;
}

function ErrorIconDisplay({ icon: Icon, className }: ErrorIconDisplayProps) {
	return <Icon className={className} />;
}

/**
 * Error hints for common error codes
 */
const ErrorHints: Record<string, string> = {
	TIMEOUT: "Try increasing the request timeout or check if the server is responding slowly",
	CONNECTION_FAILED: "Verify the URL and ensure the target server is running",
	DNS_ERROR: "Check if the domain name is correct and accessible",
	SSL_ERROR: "The server's SSL certificate may be invalid or expired",
	INVALID_URL: "Check the URL format - it should start with http:// or https://",
	ENGINE_ERROR: "The Vayu engine may not be running. Try restarting the application",
};

/**
 * Get appropriate icon for error type
 */
function getErrorIcon(errorCode?: string) {
	switch (errorCode) {
		case "TIMEOUT":
			return Clock;
		case "SSL_ERROR":
			return ShieldX;
		case "INVALID_URL":
			return Link2Off;
		case "CONNECTION_FAILED":
			return ServerOff;
		case "DNS_ERROR":
			return WifiOff;
		case "ENGINE_ERROR":
			return ServerOff;
		default:
			return AlertCircle;
	}
}

export interface ClientErrorViewProps {
	errorCode?: string;
	errorMessage?: string;
}

export default function ClientErrorView({ errorCode, errorMessage }: ClientErrorViewProps) {
	const hint = errorCode ? ErrorHints[errorCode] : undefined;
	const ErrorIcon = getErrorIcon(errorCode);

	return (
		<div className="flex-1 flex items-center justify-center p-8">
			<div className="max-w-md text-center space-y-4">
				<div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
					<ErrorIconDisplay icon={ErrorIcon} className="w-8 h-8 text-destructive-text" />
				</div>

				<div className="space-y-2">
					<h3 className="text-lg font-semibold text-foreground">
						Could not get a response
					</h3>
					<p className="text-sm text-muted-foreground">
						{errorMessage || "The request failed before reaching the server"}
					</p>
				</div>

				{/*
				 * A lucide glyph, not the emoji this tip used to open with. That was
				 * the only emoji in `modules/`, and it rendered in the OS emoji font:
				 * full colour beside 12px muted text, at whatever size and baseline
				 * that font chose, on a row where every other icon in the app is a
				 * stroked lucide mark in a token colour. It also sat inside the <p>,
				 * so it inherited nothing and aligned to nothing.
				 */}
				{hint && (
					<div className="bg-muted/50 rounded-lg p-3 text-left flex items-start gap-2">
						<Lightbulb className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
						<p className="text-xs text-muted-foreground">
							<span className="font-medium">Tip:</span> {hint}
						</p>
					</div>
				)}

				{errorCode && (
					<p className="text-xs text-muted-foreground/70 font-mono">
						Error code: {errorCode}
					</p>
				)}
			</div>
		</div>
	);
}

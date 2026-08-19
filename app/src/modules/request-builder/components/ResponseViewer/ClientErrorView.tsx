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
	Route,
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
 *
 * The proxy and TLS hints name the *setting* to go to, not just the condition
 * (issue #708). Every one of these failures is reported against the endpoint by
 * libcurl, so a hint that only restates the message sends the reader to debug a
 * server that was never reached - which is the misdiagnosis the whole
 * behind-real-networks epic exists to end.
 */
const ErrorHints: Record<string, string> = {
	TIMEOUT: "Try increasing the request timeout or check if the server is responding slowly",
	CONNECTION_FAILED: "Verify the URL and ensure the target server is running",
	DNS_ERROR: "Check if the domain name is correct and accessible",
	SSL_ERROR:
		"The certificate was not accepted. If this host is behind a TLS-inspecting proxy or an internal authority, paste its certificate into Settings > Network & connectivity > Custom CA Certificates; to skip verification for this one request, turn off Verify SSL in the Settings tab",
	PROXY_ERROR:
		"The proxy was the hop that failed, not the endpoint - check Settings > Network & connectivity > Proxy, and whether this proxy needs credentials in its URL",
	INVALID_URL: "Check the URL format - it should start with http:// or https://",
	ENGINE_ERROR: "The Vayu engine may not be running. Try restarting the application",
};

/**
 * The headline, when the generic one would misdescribe the failure.
 *
 * "Could not get a response" is true of a proxy refusal and unhelpful about it:
 * the reader's next move depends entirely on *which hop* said no, and the
 * heading is the one line they are guaranteed to read.
 */
const ErrorTitles: Record<string, string> = {
	PROXY_ERROR: "Could not reach the proxy",
	SSL_ERROR: "Could not establish a secure connection",
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
		case "PROXY_ERROR":
			return Route;
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
	const title = (errorCode ? ErrorTitles[errorCode] : undefined) ?? "Could not get a response";
	const ErrorIcon = getErrorIcon(errorCode);

	return (
		<div className="flex-1 flex items-center justify-center p-8">
			<div className="max-w-md text-center space-y-4">
				<div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
					<ErrorIconDisplay icon={ErrorIcon} className="w-8 h-8 text-destructive-text" />
				</div>

				<div className="space-y-2">
					<h3 className="text-lg font-semibold text-foreground">{title}</h3>
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
					<div className="surface-sunken rounded-md border border-rule p-3 text-left flex items-start gap-2">
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

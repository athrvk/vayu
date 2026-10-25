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
	Repeat,
	FileWarning,
	ServerOff,
	ServerCrash,
	Lightbulb,
	type LucideIcon,
} from "lucide-react";
import { ENGINE_NO_ANSWER } from "@/lib/engine-error-text";

interface ErrorIconDisplayProps {
	icon: LucideIcon;
	className: string;
}

function ErrorIconDisplay({ icon: Icon, className }: ErrorIconDisplayProps) {
	return <Icon className={className} />;
}

/**
 * The engine answered the send with an HTTP error of its own, rather than
 * reporting the target's failure as `status: 0` (issue #2458). Two spellings
 * reach here: `UNKNOWN_ERROR` is `readApiError`'s word for a body that was not
 * the engine's JSON error (its message carries the status line), and
 * `internal_error` is the engine's own code for a 5xx it explained.
 */
const ENGINE_ANSWERED_ERROR = "Vayu's engine answered with an error";
const ENGINE_ANSWERED_HINT =
	"This is Vayu's failure, not the server's. Send again; if it repeats, Vayu's engine log in Settings › General › Logs has the reason.";

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
	TIMEOUT:
		"The request didn't finish in time - the connection may never have opened, or the server took too long to answer. Raise Request timeout in this request's Settings tab or Default request timeout in Settings › Network & connectivity, or check the server.",
	CONNECTION_FAILED:
		"Nothing answered at that address. Check the URL, and that the server is running.",
	DNS_ERROR:
		"The host name didn't resolve. Check the domain for typos, and that your network can reach it.",
	SSL_ERROR:
		"The certificate wasn't accepted. If this host is behind a TLS-inspecting proxy or an internal authority, paste its certificate into Settings › Network & connectivity › Custom CA certificates. To skip verification for this request only, turn off Verify TLS certificate in its Settings tab. An https proxy's own certificate is checked by the same two settings.",
	PROXY_ERROR:
		"The proxy failed, not the endpoint. Check Settings › Network & connectivity › Proxy, and whether this proxy needs credentials in its URL.",
	INVALID_URL:
		"Vayu couldn't use that URL. It has to start with http:// or https://, and a space or other raw character has to be percent-encoded.",
	TOO_MANY_REDIRECTS:
		"The server kept redirecting. Raise Maximum redirects in this request's Settings tab, or turn off Follow redirects to see where it goes.",
	BAD_CONTENT_ENCODING:
		"The server sent a response in an encoding Vayu can't read. Set Accept-Encoding to identity in the Headers tab and send again.",
	ENGINE_ERROR: ENGINE_NO_ANSWER,
	AUTH_REQUIRED: "Open the Auth tab to get a token, then send again.",
	AUTH_FAILED: "Check the Auth tab's token settings, then send again.",
	INVALID_METHOD:
		"This method can't carry the body this request has. Remove the body, or change the method.",
	DATA_BINDING_FAILED:
		"A {{data.*}} variable names a column the bound row doesn't have. Check the column names in the data file.",
	UNKNOWN_ERROR: ENGINE_ANSWERED_HINT,
	internal_error: ENGINE_ANSWERED_HINT,
};

/**
 * The headline, when the generic one would misdescribe the failure.
 *
 * "Couldn't get a response" is true of a proxy refusal and unhelpful about it:
 * the reader's next move depends entirely on *which hop* said no, and the
 * heading is the one line they are guaranteed to read.
 *
 * `ENGINE_ERROR` is Vayu's own failure, not the network's, so it names the
 * engine rather than borrowing the network template (docs/ux-writing.md,
 * "Errors have three sources").
 *
 * `INVALID_URL` covers a URL that does not parse, one that parses but names a
 * scheme other than http or https, and one the engine will not send to (its
 * own port, a host with no ASCII name, a redirect to another scheme), so its
 * heading and its tip claim no one cause; the engine's message under it says
 * which.
 */
const ErrorTitles: Record<string, string> = {
	TIMEOUT: "No response before the timeout",
	CONNECTION_FAILED: "Couldn't connect to the server",
	DNS_ERROR: "Couldn't resolve the host name",
	PROXY_ERROR: "Couldn't reach the proxy",
	SSL_ERROR: "Couldn't establish a secure connection",
	INVALID_URL: "Couldn't send to this URL",
	TOO_MANY_REDIRECTS: "Too many redirects",
	BAD_CONTENT_ENCODING: "Couldn't decode the response",
	ENGINE_ERROR: "Vayu's engine didn't respond",
	INTERNAL_ERROR: "Couldn't send the request",
	AUTH_FAILED: "Couldn't get an OAuth 2.0 token",
	AUTH_REQUIRED: "This request needs an OAuth 2.0 token",
	INVALID_METHOD: "Couldn't send - the method doesn't allow this",
	DATA_BINDING_FAILED: "Couldn't bind the data row",
	UNKNOWN_ERROR: ENGINE_ANSWERED_ERROR,
	internal_error: ENGINE_ANSWERED_ERROR,
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
		case "TOO_MANY_REDIRECTS":
			return Repeat;
		case "BAD_CONTENT_ENCODING":
			return FileWarning;
		case "DNS_ERROR":
			return WifiOff;
		// Vayu's own failures get a glyph a target's failure never uses
		// (docs/ux-writing.md, "Errors have three sources").
		case "ENGINE_ERROR":
		case "INTERNAL_ERROR":
		case "UNKNOWN_ERROR":
		case "internal_error":
			return ServerCrash;
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
	const title = (errorCode ? ErrorTitles[errorCode] : undefined) ?? "Couldn't get a response";
	const ErrorIcon = getErrorIcon(errorCode);

	return (
		<div className="flex-1 flex items-center justify-center p-8">
			<div className="max-w-md text-center space-y-4">
				<div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
					<ErrorIconDisplay icon={ErrorIcon} className="w-8 h-8 text-destructive-text" />
				</div>

				<div className="space-y-2">
					<h3 className="text-md font-semibold text-foreground">{title}</h3>
					<p className="text-sm text-muted-foreground">
						{errorMessage || "The request never reached the server."}
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
						<Lightbulb className="size-icon-sm mt-0.5 shrink-0 text-muted-foreground" />
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

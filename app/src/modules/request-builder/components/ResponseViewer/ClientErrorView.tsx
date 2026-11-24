/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shown when a request fails before reaching the server (status 0): icon, message and a hint by
 * error type.
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
	FileX,
	Unplug,
	ServerOff,
	ServerCrash,
	Lightbulb,
	type LucideIcon,
} from "lucide-react";
import { Heading } from "@/components/ui/heading";
import { ENGINE_NO_ANSWER } from "@/lib/engine-error-text";
import { badHostTip } from "./bad-host-tip";
import { selectEngineRestartOffered, useEngineStore } from "@/stores";

interface ErrorIconDisplayProps {
	icon: LucideIcon;
	className: string;
}

function ErrorIconDisplay({ icon: Icon, className }: ErrorIconDisplayProps) {
	return <Icon className={className} />;
}

/**
 * The engine answered the send with an HTTP error of its own, not the target's failure as
 * `status: 0` (#2458). Two spellings arrive: `UNKNOWN_ERROR` is `readApiError`'s word for a
 * non-JSON error body (its message carries the status line), `internal_error` the engine's code for
 * a 5xx it explained.
 */
const ENGINE_ANSWERED_ERROR = "Vayu's engine answered with an error";
const ENGINE_ANSWERED_HINT =
	"This is Vayu's failure, not the server's. Send again; if it repeats, Vayu's engine log in Settings › General › Logs has the reason.";

/**
 * `ENGINE_ERROR`'s tip while the Dock shows its Restart or Retry button; otherwise (the engine is
 * not known to have left) the tip is the shared `ENGINE_NO_ANSWER`. The label is not named: it is
 * Retry after a start failure and a disabled Restarting… during a restart.
 */
const ENGINE_RESTART_IN_DOCK_HINT =
	"Vayu's engine isn't running or didn't answer. Start it again with the button in the status bar at the bottom of the window.";

/**
 * Hints per error code. The proxy and TLS hints name the *setting* to go to, not just the condition
 * (#708): libcurl reports every one against the endpoint, so restating the message sends the reader
 * to debug a server never reached.
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
	PROTOCOL_MISMATCH:
		"Vayu sends HTTP/1.1 over http://, and this server answered with something else, often HTTP/2 without TLS. Use https:// for it, or point the request at an endpoint that accepts HTTP/1.1.",
	ENGINE_ERROR: ENGINE_NO_ANSWER,
	AUTH_REQUIRED: "Open the Auth tab to get a token, then send again.",
	AUTH_FAILED: "Check the Auth tab's token settings, then send again.",
	UNSENDABLE_FILE:
		"A file this request names can't be sent. Choose it again in the Body tab or remove it, and check that a {{variable}} in its path has a value. A file outside the locations allowed in Settings › Files has to be picked in the request.",
	INVALID_METHOD:
		"This method can't carry the body this request has. Remove the body, or change the method.",
	DATA_BINDING_FAILED:
		"A {{data.*}} variable names a column the bound row doesn't have. Check the column names in the data file.",
	UNKNOWN_ERROR: ENGINE_ANSWERED_HINT,
	internal_error: ENGINE_ANSWERED_HINT,
};

/**
 * The headline, where the generic one misdescribes the failure: "Couldn't get a response" is true
 * of a proxy refusal but unhelpful, since the next move depends on *which hop* said no, and the
 * heading is the one line surely read.
 *
 * - `ENGINE_ERROR` is Vayu's failure, not the network's, so it names the engine
 *   (docs/ux-writing.md, "Errors have three sources").
 * - `UNSENDABLE_FILE` is the request's own file (none chosen, an unresolved variable in its path,
 *   unreadable, outside the allowed folders), refused before sending, so it names neither. An older
 *   trace reads `INTERNAL_ERROR` and keeps that title.
 * - `INVALID_URL` covers an unparseable URL, a non-http(s) scheme, and one the engine will not send
 *   to (its own port, a host with no ASCII name, a redirect to another scheme), so heading and tip
 *   claim no single cause; the engine's message says which.
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
	PROTOCOL_MISMATCH: "The server answered in another protocol",
	ENGINE_ERROR: "Vayu's engine didn't respond",
	INTERNAL_ERROR: "Couldn't send the request",
	AUTH_FAILED: "Couldn't get an OAuth 2.0 token",
	AUTH_REQUIRED: "This request needs an OAuth 2.0 token",
	INVALID_METHOD: "Couldn't send - the method doesn't allow this",
	DATA_BINDING_FAILED: "Couldn't bind the data row",
	UNSENDABLE_FILE: "Couldn't send a file in this request",
	UNKNOWN_ERROR: ENGINE_ANSWERED_ERROR,
	internal_error: ENGINE_ANSWERED_ERROR,
};

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
		case "PROTOCOL_MISMATCH":
			return Unplug;
		case "DNS_ERROR":
			return WifiOff;
		// A file the request names, not a hop or Vayu: nothing was sent.
		case "UNSENDABLE_FILE":
			return FileX;
		// Vayu's own failures get a glyph a target's never uses (docs/ux-writing.md, "Errors have
		// three sources").
		case "ENGINE_ERROR":
		case "INTERNAL_ERROR":
		case "UNKNOWN_ERROR":
		case "internal_error":
			return ServerCrash;
		default:
			return AlertCircle;
	}
}

function errorHint(
	errorCode: string | undefined,
	restartOffered: boolean,
	requestUrl: string | undefined
): string | undefined {
	if (!errorCode) return undefined;
	if (errorCode === "ENGINE_ERROR" && restartOffered) return ENGINE_RESTART_IN_DOCK_HINT;
	if (errorCode === "INVALID_URL") return badHostTip(requestUrl) ?? ErrorHints[errorCode];
	return ErrorHints[errorCode];
}

export interface ClientErrorViewProps {
	errorCode?: string;
	errorMessage?: string;
	/** The URL as the user wrote it at Send, which a host variable's name is read from. */
	requestUrl?: string;
}

export default function ClientErrorView({
	errorCode,
	errorMessage,
	requestUrl,
}: ClientErrorViewProps) {
	const restartOffered = useEngineStore(selectEngineRestartOffered);
	const hint = errorHint(errorCode, restartOffered, requestUrl);
	const title = (errorCode ? ErrorTitles[errorCode] : undefined) ?? "Couldn't get a response";
	const ErrorIcon = getErrorIcon(errorCode);

	return (
		<div className="flex-1 flex items-center justify-center p-8">
			<div className="max-w-md text-center space-y-4">
				<div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
					<ErrorIconDisplay icon={ErrorIcon} className="w-8 h-8 text-destructive-text" />
				</div>

				<div className="space-y-2">
					<Heading outside="h3" className="text-md font-semibold text-foreground">
						{title}
					</Heading>
					<p className="text-sm text-muted-foreground">
						{errorMessage || "The request never reached the server."}
					</p>
				</div>

				{/*
				 * A lucide glyph, not an emoji: an emoji renders in the OS emoji font, full colour
				 * beside 12px muted text at its own size and baseline, on a row where every other
				 * icon is a stroked lucide mark.
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
					<p className="text-xs text-muted-foreground font-mono">
						Error code: {errorCode}
					</p>
				)}
			</div>
		</div>
	);
}

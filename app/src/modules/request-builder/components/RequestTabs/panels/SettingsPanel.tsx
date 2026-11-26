/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Per-request execution settings: protocol, redirect policy, timeout, event stream. Every field is
 * stored on the request and sent on every Send and load test, never elided at the default (see the
 * payload fields in `index.tsx` and `types/api.ts`): otherwise the engine's follow default followed
 * a 3xx silently, and it never reached the response pane. One exception:
 *
 * - **Timeout** (#2937) has no default to send: an empty field is `null`, stays off the composed
 *   payload, and the engine reads `defaultTimeout` at each send. Sending today's setting would pin
 *   it, so a later change would not reach the request. The placeholder names the current value.
 * - **Event stream is a setting, not a body mode** (#574): the body is untouched (a stream is a GET
 *   as often as a POST), and it changes how the response is *delivered*, which is this tab's
 *   subject.
 * - **The stream text path is the reply's address in each event** (#3773): a JSONPath the engine
 *   runs on each event's JSON `data`, joined by the Events tab's Text view. Declared, never
 *   detected; the presets are shortcuts and the field takes any path in the elements' subset. Shown
 *   only with Event stream on, and emptied when it goes off (`streamPatch`): the engine refuses a
 *   path on a buffered request.
 * - **The first content marker is the load run's first-token clock** (#3774): literal bytes the
 *   engine watches the raw stream for, so Time to first match waits for content, not a preamble.
 *   Same rules as the text path, and kept verbatim, never trimmed, since it is matched byte for
 *   byte.
 * - **Verification off is loud, not hidden** (#706): withholding the row left an unreachable knob
 *   and no way to reach an internal host. A dangerous state says so (the warning under the toggle,
 *   the tab's badge). The row points at the usual better answer: trusting the authority in Settings
 *   › Network & connectivity keeps verification on everywhere.
 * - **The rows are the app-settings rows** (#702). Sections are `Eyebrow` (11px, uppercase, muted),
 *   and a one-row section *is* that row, so Protocol and Streaming have no heading.
 * - **Postman's per-request protocol switches live here** (#1765): the cookie jar, URL encoding,
 *   and the automatic headers this request never sends. That list is *stored*
 *   (`disabledSystemHeaders`), unlike the Headers tab's per-send untick (`disabledDefaultHeaders`,
 *   #1229), and the copy says so, since both name the same headers. Names Vayu keeps for the
 *   Postman export without applying are shown read-only beside it.
 */

import { AlertTriangle } from "lucide-react";

import { Badge, Checkbox, Eyebrow, ToggleGroup, ToggleGroupItem } from "@/components/ui";
import { useConfigQuery, useRequestDefaultsQuery } from "@/queries";
import {
	ACCEPT_HEADER,
	DEFAULT_MAX_REDIRECTS,
	HTTP_VERSIONS,
	MAX_MAX_REDIRECTS,
	MAX_REQUEST_TIMEOUT_MS,
	MIN_MAX_REDIRECTS,
	MIN_REQUEST_TIMEOUT_MS,
	SSE_ACCEPT,
	STREAM_FIRST_CONTENT_MARKER_PRESETS,
	STREAM_TEXT_PATH_PRESETS,
	isHttpVersion,
} from "@/constants/request";
import {
	NumberSettingRow,
	SelectSettingRow,
	TextSettingRow,
	ToggleRow,
} from "@/modules/settings/main/panels/SettingControls";
import { useRequestBuilderContext } from "../../../context";
import { streamPatch } from "../../../utils/auto-header";
import {
	automaticHeaderOptions,
	displayHeaderName,
	unappliedStoredHeaders,
} from "../../../utils/automatic-headers";
import {
	defaultTimeoutFrom,
	parseTimeout,
	timeoutPlaceholder,
} from "../../../utils/request-timeout";
import { pluralize } from "@/modules/dashboard/utils/format";
import { formatNumber } from "@/lib/format-number";

const FOLLOW_LABEL = "Follow redirects";
const MAX_LABEL = "Maximum redirects";
const TIMEOUT_LABEL = "Request timeout";
const PROTOCOL_LABEL = "Protocol";
const STREAM_LABEL = "Event stream";
const STREAM_TEXT_PATH_LABEL = "Stream text path";
const STREAM_MARKER_LABEL = "First content marker";
const VERIFY_LABEL = "Verify TLS certificate";
const COOKIES_LABEL = "Disable cookie jar";
const ENCODING_LABEL = "Send URL without encoding";

/** "A", "A and B", "A, B and C" - for the read-only names' reason line. */
function listNames(keys: readonly string[]): string {
	const names = keys.map(displayHeaderName);
	return names.length <= 1
		? names.join("")
		: `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export default function SettingsPanel() {
	const { request, setRequest, updateField } = useRequestBuilderContext();
	// The preset the field holds, or none once the path is anything else.
	const activePreset =
		STREAM_TEXT_PATH_PRESETS.find((preset) => preset.path === request.streamTextPath.trim())
			?.path ?? "";
	const activeMarkerPreset =
		STREAM_FIRST_CONTENT_MARKER_PRESETS.find(
			(preset) => preset === request.streamFirstContentMarker
		) ?? "";
	const followRedirects = request.followRedirects;
	const { data: requestDefaults } = useRequestDefaultsQuery();
	const { data: config } = useConfigQuery();
	const timeoutPlaceholderText = timeoutPlaceholder(defaultTimeoutFrom(config?.entries));
	const storedOff = request.disabledSystemHeaders;
	const headerOptions = automaticHeaderOptions(requestDefaults?.headers ?? [], storedOff);
	const unapplied = unappliedStoredHeaders(storedOff);

	/**
	 * Stored, so `updateField`: unlike the Headers tab's per-send untick, this changes the request
	 * and marks it unsaved. Names are lowercased, as the engine stores and Postman writes them.
	 */
	const setHeaderOff = (key: string, off: boolean) => {
		updateField(
			"disabledSystemHeaders",
			off ? [...storedOff.filter((n) => n !== key), key] : storedOff.filter((n) => n !== key)
		);
	};

	/**
	 * The URL is the query's truth and the rows hold it as written either way (#1771), so only the
	 * flag changes.
	 */
	const handleEncodingChange = (checked: boolean) => {
		updateField("disableUrlEncoding", checked);
	};

	const handleProtocolChange = (value: string) => {
		if (!isHttpVersion(value)) return;
		updateField("httpVersion", value);
	};

	/**
	 * Stream on arms `Accept: text/event-stream`; off takes that row out. One `setRequest`, not two
	 * `updateField`s: flag and headers are one change, and the rule computes the headers from the
	 * current list, which a second call would read stale. A request that declares its own `Accept`
	 * keeps it; `utils/auto-header.ts` says why ownership is by marker, not row id.
	 */
	const handleStreamChange = (checked: boolean) => {
		setRequest(streamPatch(request, checked));
	};

	const handleTextPathPreset = (path: string) => {
		// Radix reports "" when the active preset is pressed again; the field holds the path, so
		// nothing switches off.
		if (path) updateField("streamTextPath", path);
	};

	const handleMarkerPreset = (marker: string) => {
		if (marker) updateField("streamFirstContentMarker", marker);
	};

	/** Keep the stored value inside the range the engine clamps to. */
	const commitMaxRedirects = (raw: string) => {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isNaN(parsed)) return;
		updateField(
			"maxRedirects",
			Math.min(MAX_MAX_REDIRECTS, Math.max(MIN_MAX_REDIRECTS, parsed))
		);
	};

	/**
	 * An emptied field writes the default. `NumberSettingRow` holds an unparseable draft, right for
	 * a setting that may keep its old number; `maxRedirects` is a request column sent on every
	 * Send, so "empty" must serialize as something: the default, with the draft shown until a
	 * number replaces it.
	 */
	const handleMaxRedirectsDraft = (raw: string) => {
		if (raw === "") updateField("maxRedirects", DEFAULT_MAX_REDIRECTS);
	};

	/** Keep the stored value inside the range the engine accepts. */
	const commitTimeout = (raw: string) => {
		const parsed = parseTimeout(raw);
		if (parsed !== null) updateField("timeout", parsed);
	};

	/**
	 * An emptied field means "use the default", a state of its own, so it commits `null` at once,
	 * unlike `maxRedirects`, which must serialize as a number.
	 */
	const handleTimeoutDraft = (raw: string) => {
		if (raw === "") updateField("timeout", null);
	};

	return (
		<div className="space-y-6 max-w-xl">
			{/*
			 * The scope, once; the one row it is not true of (Streaming, below) says so itself.
			 */}
			<p className="text-xs text-muted-foreground">
				Stored on the request and sent with every Send and every load test.
			</p>

			<SelectSettingRow
				label={PROTOCOL_LABEL}
				value={request.httpVersion}
				onChange={handleProtocolChange}
				options={HTTP_VERSIONS}
				description="The HTTP protocol to negotiate."
			/>

			<NumberSettingRow
				label={TIMEOUT_LABEL}
				value={request.timeout === null ? "" : String(request.timeout)}
				placeholder={timeoutPlaceholderText}
				commit="change"
				onCommit={commitTimeout}
				onDraftChange={handleTimeoutDraft}
				unit="ms"
				min={String(MIN_REQUEST_TIMEOUT_MS)}
				max={String(MAX_REQUEST_TIMEOUT_MS)}
				rangeHint={`${formatNumber(MIN_REQUEST_TIMEOUT_MS)} - ${formatNumber(MAX_REQUEST_TIMEOUT_MS)}`}
				description="How long Send and load tests wait for the whole transfer. Leave empty to use the default timeout in Settings › Network & connectivity."
			/>

			<div className="space-y-4">
				<Eyebrow>Redirects</Eyebrow>

				<ToggleRow
					label={FOLLOW_LABEL}
					checked={followRedirects}
					onChange={(checked) => updateField("followRedirects", checked)}
					description={
						<>
							Off shows the 3xx itself - its status and <code>Location</code> header -
							instead of the page it points at.
						</>
					}
				/>

				<NumberSettingRow
					label={MAX_LABEL}
					value={String(request.maxRedirects)}
					commit="change"
					onCommit={commitMaxRedirects}
					onDraftChange={handleMaxRedirectsDraft}
					min={String(MIN_MAX_REDIRECTS)}
					max={String(MAX_MAX_REDIRECTS)}
					disabled={!followRedirects}
					defaultValue={String(DEFAULT_MAX_REDIRECTS)}
					onResetToDefault={() => updateField("maxRedirects", DEFAULT_MAX_REDIRECTS)}
					description={
						followRedirects
							? "Hops to follow before giving up."
							: "Only applies while Follow redirects is on."
					}
				/>
			</div>

			<div className="space-y-4">
				<Eyebrow>Security</Eyebrow>

				<ToggleRow
					label={VERIFY_LABEL}
					checked={request.verifySSL}
					onChange={(checked) => updateField("verifySSL", checked)}
					description={
						<>
							Off skips the certificate check entirely - hostname included - so an
							internal or self-signed host answers instead of failing. To keep
							verification on, add the authority under Settings › Network &amp;
							connectivity instead.
						</>
					}
				/>

				{/*
				 * Text, not a Badge: it paints no background (the `badge-hover.test.tsx` rule), as
				 * the response bar's protocol-downgrade line does, so the builder's two warnings
				 * read as one thing.
				 */}
				{!request.verifySSL && (
					<div className="enter-fade flex items-start gap-1.5 text-xs text-status-warning-text">
						<AlertTriangle className="size-icon-sm mt-0.5 shrink-0" />
						<span>
							This request accepts any certificate. A machine in the middle can read
							and rewrite it - Send, load tests, and streams alike.
						</span>
					</div>
				)}
			</div>

			<div className="space-y-4">
				<Eyebrow>Cookies &amp; URL</Eyebrow>

				<ToggleRow
					label={COOKIES_LABEL}
					checked={request.disableCookies}
					onChange={(checked) => updateField("disableCookies", checked)}
					description={
						<>
							No cookie from the jar is attached and no <code>Set-Cookie</code> is
							stored. A <code>Cookie</code> header in the Headers tab is still sent.
						</>
					}
				/>

				<ToggleRow
					label={ENCODING_LABEL}
					checked={request.disableUrlEncoding}
					onChange={handleEncodingChange}
					description={
						<>
							Path variable values, query rows and an API key in the query go out as
							typed. Without it, a path value has its space, <code>&quot;</code>,{" "}
							<code>&lt;</code>, <code>&gt;</code>, <code>`</code>, <code>#</code>,{" "}
							<code>?</code>, <code>{"{"}</code>, <code>{"}"}</code> and non-ASCII
							characters percent-encoded, and a query row or API key is encoded in
							full. A URL with a space in it is still refused.
						</>
					}
				/>
			</div>

			<div className="space-y-2">
				<div>
					<Eyebrow>Don&apos;t send automatic headers</Eyebrow>
					<p className="text-xs text-muted-foreground mt-0.5">
						Ticked headers are left off every send of this request. Unticking one in the
						Headers tab skips it for a single send only.
					</p>
				</div>

				<div className="space-y-1">
					{headerOptions.map((option) => (
						<label
							key={option.key}
							className="flex w-fit items-center gap-2 text-xs"
							data-automatic-header={option.key}
						>
							<Checkbox
								checked={storedOff.includes(option.key)}
								onChange={(e) => setHeaderOff(option.key, e.target.checked)}
								aria-label={`Don't send ${option.name}`}
								// `size-target` (issue #1679): the box is its own hit target
								// beside a label, as in the Headers tab's rows.
								className="size-target"
							/>
							<span className="font-mono shrink-0 whitespace-nowrap">
								{option.name}
							</span>
							<span className="text-muted-foreground">{option.detail}</span>
						</label>
					))}
				</div>

				{/*
				 * Read-only: Postman lets these be switched off, Vayu cannot honour
				 * that, and the name is kept only so the export writes back what
				 * was imported. The reason is spelled out rather than implied by a
				 * disabled checkbox, which would read as "on, but locked".
				 */}
				{unapplied.neverSent.length + unapplied.cannotOmit.length > 0 && (
					<div className="space-y-1" data-kept-not-applied>
						<div className="flex flex-wrap items-center gap-1">
							<span className="text-xs text-muted-foreground">
								Kept for the Postman export:
							</span>
							{[...unapplied.neverSent, ...unapplied.cannotOmit].map((key) => (
								<Badge
									key={key}
									variant="outline"
									className="font-mono font-normal"
								>
									{displayHeaderName(key)}
								</Badge>
							))}
						</div>
						<p className="text-xs text-muted-foreground">
							{unapplied.neverSent.length > 0 &&
								`Vayu never sends ${listNames(unapplied.neverSent)}. `}
							{unapplied.cannotOmit.length > 0 &&
								`Vayu can't leave out ${listNames(unapplied.cannotOmit)}: HTTP/1.1 needs ${pluralize(unapplied.cannotOmit.length, "it", "them")}.`}
						</p>
					</div>
				)}
			</div>

			<ToggleRow
				label={STREAM_LABEL}
				checked={request.stream}
				onChange={handleStreamChange}
				description={
					<>
						Send returns as soon as the stream opens and events arrive live in the
						Events tab, instead of waiting for a body that never completes. Adds{" "}
						<code>
							{ACCEPT_HEADER}: {SSE_ACCEPT}
						</code>{" "}
						unless this request already declares one. Applies to Send, to load tests and
						to collection runs; a run&apos;s stream ends at the caps set in its dialog.
					</>
				}
			/>

			{/*
			 * Kept, but no longer a refusal: #612 shipped scripts on a streaming
			 * send, so what is worth saying here is *when* they run (issue #620).
			 * Send answers as soon as the stream opens, so the Tests script - and
			 * its results in the Tests and Console panes - arrive only once the
			 * stream has terminated, over the buffered event list rather than per
			 * event. That timing is invisible from this tab otherwise, and it
			 * applies to the scripts inherited from the collection chain too.
			 */}
			{request.stream && (
				<>
					<div className="enter-fade">
						<TextSettingRow
							label={STREAM_TEXT_PATH_LABEL}
							value={request.streamTextPath}
							onChange={(path) => updateField("streamTextPath", path)}
							placeholder={STREAM_TEXT_PATH_PRESETS[0].path}
							monospace
							description="A JSONPath read on each event's JSON data. What it finds is joined in the Events tab's Text view; an event it does not match, or whose data is not JSON, is skipped. Leave empty to show rows only."
						>
							<ToggleGroup
								value={activePreset}
								onValueChange={handleTextPathPreset}
								aria-label="Stream text path presets"
							>
								{STREAM_TEXT_PATH_PRESETS.map((preset) => (
									<ToggleGroupItem key={preset.path} value={preset.path}>
										{preset.label}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</TextSettingRow>
					</div>

					<div className="enter-fade">
						<TextSettingRow
							label={STREAM_MARKER_LABEL}
							value={request.streamFirstContentMarker}
							onChange={(marker) => updateField("streamFirstContentMarker", marker)}
							placeholder={STREAM_FIRST_CONTENT_MARKER_PRESETS[0]}
							monospace
							description="Load tests time each stream to the first appearance of these bytes, as Time to first match, so a preamble event does not read as the first token. It is matched against the raw stream, not the parsed JSON, and a server's spacing and escaping decide what it must say. Leave empty for none."
						>
							<ToggleGroup
								value={activeMarkerPreset}
								onValueChange={handleMarkerPreset}
								aria-label="First content marker presets"
							>
								{STREAM_FIRST_CONTENT_MARKER_PRESETS.map((preset) => (
									<ToggleGroupItem
										key={preset}
										value={preset}
										className="font-mono"
									>
										{preset}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</TextSettingRow>
					</div>

					<p className="enter-fade text-xs text-muted-foreground">
						Scripts run, split around the transfer: the pre-request script before the
						stream opens, and the post-request script once after it ends, reading the
						whole stream as <code>pm.response.events</code>. Results appear when the
						stream finishes, not when Send returns.
					</p>
				</>
			)}
		</div>
	);
}

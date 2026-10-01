/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SettingsPanel Component
 *
 * Per-request execution settings: the protocol to negotiate, the redirect
 * policy, and whether the response is consumed as an event stream. The engine
 * has always accepted `followRedirects` / `maxRedirects` and defaulted to
 * following, but nothing in the app sent them, so a 3xx was followed silently
 * and never reached the response pane. Every field here is stored on the
 * request and sent on every Send and every load test, never elided even when it
 * equals the default - see the comment on the payload fields in `index.tsx` and
 * `types/api.ts`.
 *
 * **Event stream is a setting, not a body mode** (issue #574). The request's
 * body semantics are untouched by it - a stream is a GET as often as it is a
 * POST - and what it changes is how the response is *delivered*, which is
 * exactly what this tab is for.
 *
 * **Verification off is loud, not hidden** (issue #706). The row was withheld
 * for years on the grounds that exposing it weakens transport security; what
 * that produced was an unreachable knob and users with no way to reach an
 * internal host at all. The answer to a dangerous state is to make it say so -
 * the warning line below the toggle, and the Settings tab's own badge - not to
 * remove the control and leave the trust store as the only way out. The row
 * says which of the two the reader probably wants: trusting the authority in
 * Settings › Network & connectivity keeps verification on everywhere.
 *
 * **The rows are the app-settings rows** (issue #702). This tab used to
 * hand-roll a toggle arrangement, a number field and a labelled dropdown that
 * `SettingControls` already defines, and paid for it twice over: the rows drifted
 * from the settings screen's, and its `h3` section headings were `text-sm
 * font-medium` - the same type as the control labels below them - so six
 * sibling headings read where three groups were meant. Sections are `Eyebrow`
 * now (11px, uppercase, muted), and a section holding one row *is* that row,
 * which is why Protocol and Streaming carry no heading of their own.
 *
 * **Postman's per-request protocol switches live here too** (issue #1765):
 * the cookie jar, URL encoding, and the automatic headers this request never
 * sends. The header list is *stored* (`disabledSystemHeaders`), unlike the
 * Headers tab's per-send untick (`disabledDefaultHeaders`, #1229), and the copy
 * says so, because the two lists name the same headers. Names Vayu keeps for
 * the Postman export without applying are shown, read-only, beside it.
 */

import { AlertTriangle } from "lucide-react";

import { Badge, Checkbox, Eyebrow } from "@/components/ui";
import { useRequestDefaultsQuery } from "@/queries";
import {
	ACCEPT_HEADER,
	DEFAULT_MAX_REDIRECTS,
	HTTP_VERSIONS,
	MAX_MAX_REDIRECTS,
	MIN_MAX_REDIRECTS,
	SSE_ACCEPT,
	isHttpVersion,
} from "@/constants/request";
import {
	NumberSettingRow,
	SelectSettingRow,
	ToggleRow,
} from "@/modules/settings/main/panels/SettingControls";
import { useRequestBuilderContext } from "../../../context";
import { switchAutoHeader } from "../../../utils/auto-header";
import {
	automaticHeaderOptions,
	displayHeaderName,
	unappliedStoredHeaders,
} from "../../../utils/automatic-headers";

const FOLLOW_LABEL = "Follow redirects";
const MAX_LABEL = "Maximum redirects";
const PROTOCOL_LABEL = "Protocol";
const STREAM_LABEL = "Event stream";
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
	const followRedirects = request.followRedirects;
	const { data: requestDefaults } = useRequestDefaultsQuery();
	const storedOff = request.disabledSystemHeaders;
	const headerOptions = automaticHeaderOptions(requestDefaults?.headers ?? [], storedOff);
	const unapplied = unappliedStoredHeaders(storedOff);

	/**
	 * Stored, so `updateField`: unlike the Headers tab's per-send untick, this
	 * is a change to the request and should mark it unsaved. Names are kept
	 * lowercased, the form the engine stores and Postman writes.
	 */
	const setHeaderOff = (key: string, off: boolean) => {
		updateField(
			"disabledSystemHeaders",
			off ? [...storedOff.filter((n) => n !== key), key] : storedOff.filter((n) => n !== key)
		);
	};

	/**
	 * The URL is the query's truth and the rows hold it as written in either
	 * mode (#1771), so the flag is all the switch changes.
	 */
	const handleEncodingChange = (checked: boolean) => {
		updateField("disableUrlEncoding", checked);
	};

	const handleProtocolChange = (value: string) => {
		if (!isHttpVersion(value)) return;
		updateField("httpVersion", value);
	};

	/**
	 * Turning the stream on arms `Accept: text/event-stream`; turning it off
	 * takes that row back out again.
	 *
	 * `setRequest` once rather than two `updateField` calls: the flag and the
	 * headers are one change, and the rule computes the new header list from the
	 * current one - a second call would compute against the array it had before
	 * the first. A request that already declares an `Accept` keeps it; see
	 * `utils/auto-header.ts` for why ownership is by marker, not by row id.
	 */
	const handleStreamChange = (checked: boolean) => {
		const next = switchAutoHeader(
			ACCEPT_HEADER,
			checked ? SSE_ACCEPT : null,
			request.headers,
			"stream"
		);
		setRequest({ stream: checked, headers: next.headers });
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
	 * An emptied field writes the default rather than nothing.
	 *
	 * `NumberSettingRow` holds an unparseable draft instead of committing it,
	 * which is right for a setting whose owner may simply keep the old number.
	 * This one has no such state: `maxRedirects` is a column on the request and
	 * goes out on every Send, so "empty" would have to be serialized as
	 * something. It is serialized as the default, and the draft stays on screen
	 * until a number replaces it.
	 */
	const handleMaxRedirectsDraft = (raw: string) => {
		if (raw === "") updateField("maxRedirects", DEFAULT_MAX_REDIRECTS);
	};

	return (
		<div className="space-y-6 max-w-xl">
			{/*
			 * The scope, once. It was on all three sections, in two variants, and
			 * the one row it is not true of says so itself (Streaming, below).
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
				 * Text, not a Badge: it paints no background, which is the rule
				 * `badge-hover.test.tsx` exists for - and the same treatment the
				 * response bar gives its protocol-downgrade line, so the two
				 * warnings in the request builder read as one thing.
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
								`Vayu can't leave out ${listNames(unapplied.cannotOmit)}: HTTP/1.1 needs ${unapplied.cannotOmit.length === 1 ? "it" : "them"}.`}
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
						unless this request already declares one. Applies to Send; a load test
						always buffers.
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
				<p className="enter-fade text-xs text-muted-foreground">
					Scripts run, split around the transfer: the pre-request script before the stream
					opens, and the post-request script once after it ends, reading the whole stream
					as <code>pm.response.events</code>. Results appear when the stream finishes, not
					when Send returns.
				</p>
			)}
		</div>
	);
}

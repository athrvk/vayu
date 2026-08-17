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
 * `verifySSL` is deliberately not exposed here - it weakens transport security
 * and was deferred; issue #706 is the record and the place it will land.
 *
 * **The rows are the app-settings rows** (issue #702). This tab used to
 * hand-roll a toggle arrangement, a number field and a labelled dropdown that
 * `SettingControls` already defines, and paid for it twice over: the rows drifted
 * from the settings screen's, and its `h3` section headings were `text-sm
 * font-medium` - the same type as the control labels below them - so six
 * sibling headings read where three groups were meant. Sections are `Eyebrow`
 * now (11px, uppercase, muted), and a section holding one row *is* that row,
 * which is why Protocol and Streaming carry no heading of their own.
 */

import { Eyebrow } from "@/components/ui";
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

const FOLLOW_LABEL = "Follow redirects";
const MAX_LABEL = "Maximum redirects";
const PROTOCOL_LABEL = "Protocol";
const STREAM_LABEL = "Event stream";

export default function SettingsPanel() {
	const { request, setRequest, updateField, getAutoAccept, setAutoAccept } =
		useRequestBuilderContext();
	const followRedirects = request.followRedirects;

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
	 * `utils/auto-header.ts` for why ownership is by row id.
	 */
	const handleStreamChange = (checked: boolean) => {
		const next = switchAutoHeader(
			ACCEPT_HEADER,
			checked ? SSE_ACCEPT : null,
			request.headers,
			request.id,
			getAutoAccept()
		);
		setRequest({ stream: checked, headers: next.headers });
		setAutoAccept(next.auto);
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
				<p className="text-xs text-muted-foreground">
					Scripts run, split around the transfer: Pre-request before the stream opens, and
					Tests once after it ends, reading the whole stream as{" "}
					<code>pm.response.events</code>. Results appear when the stream finishes, not
					when Send returns.
				</p>
			)}
		</div>
	);
}

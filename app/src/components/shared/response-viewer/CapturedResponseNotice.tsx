/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a captured load-run response is *not*, said out loud.
 *
 * A load run captures its failures, its slow outliers and a few exemplars of
 * each status code, within a per-body cap and a whole-run budget. All three
 * limits can leave a reader looking at something that is not the response the
 * server sent, and the difference is invisible in the bytes:
 *
 * - a truncated body ends mid-JSON and looks like a malformed response;
 * - a body dropped for budget looks like an empty response;
 * - a binary body has no text at all, and rendering the bytes as text would
 *   produce a mojibake that reads like a real one.
 *
 * Both surfaces that show captured samples (the dashboard's Sampled Requests
 * and the history Samples tab) render this, so the wording exists once instead
 * of twice and drifting.
 */

import { Callout } from "../Callout";
import { formatBytes } from "@/modules/settings/utils/format-size";
import type { RunSample } from "@/types/domain";

export interface CapturedResponseNoticeProps {
	response: RunSample["response"];
	className?: string;
}

export function CapturedResponseNotice({ response, className }: CapturedResponseNoticeProps) {
	if (response.binary) {
		return (
			<Callout severity="info" title="Binary response" className={className}>
				{formatBytes(response.bodyBytes)}
				{response.contentType ? ` of ${response.contentType}` : ""} was received. Binary
				bodies are recorded by size and type rather than stored as text, which would show
				you a corrupted version of them.
			</Callout>
		);
	}

	if (response.bodyDropped) {
		return (
			<Callout severity="warning" title="Body not captured" className={className}>
				This response was {formatBytes(response.bodyBytes)}, but the run had already spent
				its capture budget. Its headers were kept; the body was not. Raise{" "}
				<code>maxSampleBytes</code> in Settings to capture more.
			</Callout>
		);
	}

	if (response.bodyTruncated) {
		return (
			<Callout severity="info" title="Body truncated" className={className}>
				Showing the first part of a {formatBytes(response.bodyBytes)} response. Raise{" "}
				<code>maxSampleBodyBytes</code> in Settings to keep more of each captured body.
			</Callout>
		);
	}

	return null;
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a captured load-run response is *not*, said aloud. A load run captures failures, slow
 * outliers and a few exemplars per status code, within a per-body cap and a whole-run budget, and
 * each limit can show something other than what the server sent, invisibly in the bytes:
 *
 * - a truncated body ends mid-JSON and looks malformed;
 * - a body dropped for budget looks empty;
 * - a binary body has no text, and its bytes as text would be mojibake that reads as real.
 *
 * The dashboard's Sampled Requests and the history Samples tab both render it, so the wording lives
 * once.
 */

import { Callout } from "../Callout";
import { formatBytes } from "@/lib/format-number";
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

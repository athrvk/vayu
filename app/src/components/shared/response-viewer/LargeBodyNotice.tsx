/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The notice a pane shows when it holds back part of a body past
 * `LARGE_BODY_BYTES` (issue #3138). The Body tab and the Raw tab each apply the
 * cap on their own, so the wording lives here once rather than in both.
 *
 * Said by the pane that made the decision, because it is that pane's own limit,
 * not something the engine or the store did to the response. The separate "the
 * engine only read this much" notice lives in the request builder's viewer and
 * both can be on screen at once.
 *
 * The caller owns the Download sentence: only it knows whether a Download
 * button exists on screen, and where.
 */

import { Callout } from "../Callout";
import { formatSize, LARGE_BODY_BYTES } from "./utils";

export interface LargeBodyNoticeProps {
	/** The full length of the body, in the characters `LARGE_BODY_BYTES` counts. */
	bodyLength: number;
	/** The Body tab drops formatting at this size; the Raw tab never formats. */
	formattingOff?: boolean;
	/** A closing sentence about Download; omitted where nothing on screen downloads. */
	downloadNote?: string;
}

export function LargeBodyNotice({ bodyLength, formattingOff, downloadNote }: LargeBodyNoticeProps) {
	const shown = `the first ${formatSize(LARGE_BODY_BYTES)} is shown here, so the pane stays responsive.`;
	const lead = formattingOff ? "Formatting is off and only" : "Only";
	return (
		<div className="shrink-0 px-4 pt-3">
			<Callout severity="info" title="Large response">
				{`This body is ${formatSize(bodyLength)}. ${lead} ${shown}${downloadNote ? ` ${downloadNote}` : ""}`}
			</Callout>
		</div>
	);
}

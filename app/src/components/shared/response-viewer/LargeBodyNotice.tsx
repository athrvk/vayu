/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The notice a pane shows when holding back a body past `LARGE_BODY_BYTES` (#3138); the Body and
 * Raw tabs cap independently, so the wording lives once. Said by the pane that decided, as the
 * limit is its own, not the engine's or the store's; the request builder's "the engine only read
 * this much" notice is separate, and both can show. The caller owns the Download sentence: only it
 * knows whether and where a Download button is.
 */

import { Callout } from "../Callout";
import { formatBytes } from "@/lib/format-number";
import { LARGE_BODY_BYTES } from "./utils";

export interface LargeBodyNoticeProps {
	/** The full length of the body, in the characters `LARGE_BODY_BYTES` counts. */
	bodyLength: number;
	/** The Body tab drops formatting at this size; the Raw tab never formats. */
	formattingOff?: boolean;
	/** A closing sentence about Download; omitted where nothing on screen downloads. */
	downloadNote?: string;
}

export function LargeBodyNotice({ bodyLength, formattingOff, downloadNote }: LargeBodyNoticeProps) {
	const shown = `the first ${formatBytes(LARGE_BODY_BYTES)} is shown here, so the pane stays responsive.`;
	const lead = formattingOff ? "Formatting is off and only" : "Only";
	return (
		<div className="shrink-0 px-4 pt-3">
			<Callout severity="info" title="Large response">
				{`This body is ${formatBytes(bodyLength)}. ${lead} ${shown}${downloadNote ? ` ${downloadNote}` : ""}`}
			</Callout>
		</div>
	);
}

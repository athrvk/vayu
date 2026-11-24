/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The action on an `assert.snapshot` row that records the baseline (#3807):
 * "use what the server just answered". It reads the builder's current response
 * and hands the list at the element's method to `onRecord`, which writes it into
 * the element through the same path a typed edit takes, so the row's summary and
 * the baseline field follow.
 *
 * Lives here, not in `components/shared/ElementList`, because the response is
 * the request builder's: the list renders the control through `renderAboveForm`
 * and stays ignorant of it (the collection's Elements tab has no response).
 */

import { Button, DisabledHint } from "@/components/ui";
import type { ElementDef } from "@/types";
import {
	SNAPSHOT_RESULT_KEYS,
	baselineFromReply,
	snapshotMethodOf,
} from "../../../utils/list-snapshot-baseline";

interface SnapshotBaselineActionProps {
	element: ElementDef;
	/** The current response's body; `undefined` before anything was sent. */
	replyBody: string | undefined;
	onRecord: (baseline: unknown[]) => void;
}

/** Why there is nothing to record, or `undefined` when there is. */
function cannotRecordReason(
	replyBody: string | undefined,
	method: string,
	baseline: unknown[] | null
): string | undefined {
	if (baseline) return undefined;
	if (!replyBody) return "Send the request first - there is no reply to record";
	const list = SNAPSHOT_RESULT_KEYS[method] ?? method;
	return `The current reply holds no ${list} list to record`;
}

export default function SnapshotBaselineAction({
	element,
	replyBody,
	onRecord,
}: SnapshotBaselineActionProps) {
	const method = snapshotMethodOf(element.config);
	const baseline = replyBody ? baselineFromReply(replyBody, method) : null;

	return (
		<DisabledHint reason={cannotRecordReason(replyBody, method, baseline)}>
			<Button
				variant="outline"
				size="sm"
				disabled={!baseline}
				onClick={() => baseline && onRecord(baseline)}
			>
				Use the current reply as the baseline
			</Button>
		</DisabledHint>
	);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { TimeHoverCard } from "@/components/shared/TimeValue/TimeHoverCard";
import type { TimeRow } from "@/lib/time-value";
import type { TokenAnchorRect } from "./context";
import { EditorTokenTooltip } from "./EditorTokenTooltip";

/** A time the pointer is resting on in an editor, with the card's rows. */
export interface TimeHoverRequest {
	rect: TokenAnchorRect;
	/** The time as written, for the trigger's accessible name. */
	text: string;
	rows: TimeRow[];
}

/**
 * The time card over a time in a Monaco editor (issue #1786): the same rows
 * `TimeValue` shows on Vayu's own surfaces, in the same tooltip shell the
 * `{{token}}` card uses. Read-only by design - a time has nothing to edit, so
 * there is no popover behind it.
 *
 * Drawn by `CodeEditor` itself rather than by `EditorVariableTokensProvider`:
 * times are underlined in every editor, and the response viewers, the console
 * and the settings preview have no provider above them.
 */
export function TimeTokenCard({ request }: { request: TimeHoverRequest }) {
	return (
		<EditorTokenTooltip rect={request.rect} label={request.text}>
			<TimeHoverCard rows={request.rows} />
		</EditorTokenTooltip>
	);
}

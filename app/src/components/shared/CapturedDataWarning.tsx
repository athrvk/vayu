/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "The responses below were stored verbatim", wherever a run's captured exchanges show. Capture
 * does not redact, deliberately and as design-mode traces store request headers as sent; the
 * mitigation is this notice plus the run's persisted marker (`sampling.responseBodiesCaptured`),
 * not a UI guess at which field is a credential, wrong both ways and falsely reassuring one of
 * them. Silent when nothing was captured and on runs recorded before capture (absent, not zero).
 * Both surfaces showing captured samples render it, so the wording lives once.
 * `StoredExchangeWarning` is the design-mode half, over a collection run's stored step exchanges:
 * change the claim in one, read the other.
 */

import { Callout } from "./Callout";
import type { RunReport } from "@/types/domain";
import { pickByCount, pluralize } from "@/modules/dashboard/utils/format";

export interface CapturedDataWarningProps {
	sampling: RunReport["sampling"];
	className?: string;
}

export function CapturedDataWarning({ sampling, className }: CapturedDataWarningProps) {
	const captured = sampling?.responseBodiesCaptured ?? 0;
	if (captured <= 0) return null;

	const droppedForBudget = sampling?.sampleBodiesDropped ?? 0;

	return (
		<Callout severity="warning" title="Captured response data" className={className}>
			This run stored {captured.toLocaleString()} {pluralize(captured, "response")} exactly as
			received, headers included, so anything credential-shaped the server sent - a{" "}
			<code>Set-Cookie</code>, a token in a body - is stored with them. It is deleted when the
			run is, so the <code>maxRunsRetained</code> setting is its expiry.
			{droppedForBudget > 0 && (
				<>
					{" "}
					{droppedForBudget.toLocaleString()} further{" "}
					{pickByCount(droppedForBudget, { one: "body was", other: "bodies were" })} not
					captured once the run&apos;s budget was spent.
				</>
			)}
		</Callout>
	);
}

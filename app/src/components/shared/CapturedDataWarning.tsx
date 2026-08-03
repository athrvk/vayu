/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "The responses below were stored verbatim" - wherever a run's captured
 * exchanges are on screen.
 *
 * Capture does not redact, deliberately and consistently with design-mode
 * traces, which already store request headers as sent. The mitigation for that
 * decision is this notice plus the run's own persisted marker
 * (`sampling.responseBodiesCaptured`), rather than the UI trying to guess which
 * header or body field is a credential - a guess that is wrong in both
 * directions and gives false confidence when it is wrong the reassuring way.
 *
 * Silent when the run captured nothing, and silent on runs recorded before
 * capture existed (the field is absent, not zero). Both surfaces that show
 * captured samples render it, so the wording lives here once.
 */

import { Callout } from "./Callout";
import type { RunReport } from "@/types/domain";

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
			This run stored {captured.toLocaleString()} response
			{captured === 1 ? "" : "s"} exactly as received, headers included, so anything
			credential-shaped the server sent - a <code>Set-Cookie</code>, a token in a body - is
			stored with them. It is deleted when the run is, so the <code>maxRunsRetained</code>{" "}
			setting is its expiry.
			{droppedForBudget > 0 && (
				<>
					{" "}
					{droppedForBudget.toLocaleString()} further{" "}
					{droppedForBudget === 1 ? "body was" : "bodies were"} not captured once the
					run&apos;s budget was spent.
				</>
			)}
		</Callout>
	);
}

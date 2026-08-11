/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What every caller of the inbox receives.
 *
 * Its own component so the two fields can be *drafts* - typing "50" on the way
 * to "500" must not push a 50 at the next caller - and so re-seeding them from
 * the engine is a remount (the caller keys this on the served values) rather
 * than a setState inside an effect.
 */

import { useState } from "react";
import { Button, Input, Label } from "@/components/ui";
import { useToastStore } from "@/stores";
import type { InboxCannedResponse } from "@/types";

interface CannedResponseControlsProps {
	response: InboxCannedResponse;
	pending: boolean;
	onApply: (response: Partial<InboxCannedResponse>) => void;
}

export function CannedResponseControls({
	response,
	pending,
	onApply,
}: CannedResponseControlsProps) {
	const showToast = useToastStore((s) => s.showToast);
	const [statusDraft, setStatusDraft] = useState(String(response.status));
	const [delayDraft, setDelayDraft] = useState(String(response.delayMs));

	const apply = () => {
		const status = Number(statusDraft);
		const delayMs = Number(delayDraft);
		// Checked here as well as engine-side: the engine's 400 arrives as a
		// toast with no field to point at, and both fields are typed by hand.
		if (!Number.isInteger(status) || status < 100 || status > 599) {
			showToast("Reply status must be a whole number between 100 and 599", "error");
			return;
		}
		if (!Number.isInteger(delayMs) || delayMs < 0) {
			showToast("Reply delay must be a whole number of milliseconds", "error");
			return;
		}
		onApply({ status, delayMs });
	};

	return (
		<div className="flex flex-wrap items-end gap-3 border-b border-border px-3 py-2">
			<div className="flex flex-col gap-1">
				<Label htmlFor="inbox-status" className="text-xs">
					Reply status
				</Label>
				<Input
					id="inbox-status"
					className="h-7 w-24 font-mono text-xs"
					value={statusDraft}
					onChange={(e) => setStatusDraft(e.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor="inbox-delay" className="text-xs">
					Reply delay (ms)
				</Label>
				<Input
					id="inbox-delay"
					className="h-7 w-24 font-mono text-xs"
					value={delayDraft}
					onChange={(e) => setDelayDraft(e.target.value)}
				/>
			</div>
			<Button variant="outline" size="sm" onClick={apply} disabled={pending}>
				Apply
			</Button>
			{/* The pair exists to test a sender's retry logic; saying so is cheaper
			    than a doc nobody opens mid-debug. */}
			<p className="text-xs text-muted-foreground">
				What every caller receives - a 500 with a delay exercises their retries.
			</p>
		</div>
	);
}

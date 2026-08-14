/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What every caller of the inbox receives.
 *
 * All four fields the engine serves, not the two this used to show (issue
 * #556): a reply body or header set that an agent or a bare curl configured was
 * invisible here and could not be authored here, which made the panel a partial
 * view claiming to be the whole one.
 *
 * Its own component so every field can be a *draft* - typing "50" on the way to
 * "500" must not push a 50 at the next caller - and so re-seeding them from the
 * engine is a remount (the caller keys this on the served values) rather than a
 * setState inside an effect.
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
	Button,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	Input,
	Label,
	Textarea,
} from "@/components/ui";
import KeyValueEditor from "@/modules/request-builder/shared/KeyValueEditor";
import { toKeyValueItems } from "@/modules/request-builder/utils/key-value";
import type { KeyValueItem } from "@/modules/request-builder/types";
import { useToastStore } from "@/stores";
import { cn } from "@/lib/utils";
import type { InboxCannedResponse } from "@/types";

/**
 * The engine's cap on the artificial delay (`MAX_RESPONSE_DELAY_MS`).
 *
 * Mirrored rather than fetched: it is a rail, not a setting - the delay holds a
 * listener thread for its whole duration and the teardown join waits on it - so
 * there is no per-engine value to read. Checked here as well as engine-side so
 * an over-long delay names the bound instead of arriving as a bare 400.
 */
const MAX_RESPONSE_DELAY_MS = 30000;

/**
 * The served header set as editor rows, with the trailing blank row the table
 * always keeps.
 *
 * `KeyValueEditor` is the app's key/value table and these rows used to be a
 * hand-rolled pair of `Input`s, because `KeyValueRow` threw outside
 * `RequestBuilderProvider` (#564). No `variables` is passed: a canned reply has
 * no variable scope, so nothing resolves and no `{{` autocomplete opens - which
 * is what a header set the engine echoes verbatim actually is.
 */
function toHeaderRows(headers: Record<string, string>): KeyValueItem[] {
	return toKeyValueItems(
		Object.entries(headers).map(([key, value]) => ({ key, value, enabled: true }))
	);
}

interface CannedResponseControlsProps {
	response: InboxCannedResponse;
	pending: boolean;
	/**
	 * The listener is gone. `PUT /inbox/:id` still merge-patches a stopped
	 * record, so every control here would accept an edit that nothing will ever
	 * serve - the panel says so and takes no input rather than lying twice.
	 */
	stopped: boolean;
	onApply: (response: Partial<InboxCannedResponse>) => void;
}

export function CannedResponseControls({
	response,
	pending,
	stopped,
	onApply,
}: CannedResponseControlsProps) {
	const showToast = useToastStore((s) => s.showToast);
	const [statusDraft, setStatusDraft] = useState(String(response.status));
	const [delayDraft, setDelayDraft] = useState(String(response.delayMs));
	const [bodyDraft, setBodyDraft] = useState(response.body);
	const [headerRows, setHeaderRows] = useState<KeyValueItem[]>(() =>
		toHeaderRows(response.headers)
	);
	// Open when there is something to see: a configured body or header set is
	// part of what the inbox answers with, and a reader who has to go looking
	// for it is the defect this fixes.
	const [detailsOpen, setDetailsOpen] = useState(
		response.body !== "" || Object.keys(response.headers).length > 0
	);

	const disabled = stopped || pending;

	/**
	 * Read the four drafts back, or say which one is wrong.
	 *
	 * Every check here is also an engine check. The duplication is deliberate:
	 * the engine's 400 arrives as a toast with no field to point at, and all
	 * four of these are typed by hand.
	 */
	const collect = (): Partial<InboxCannedResponse> | null => {
		const status = Number(statusDraft);
		if (!Number.isInteger(status) || status < 100 || status > 599) {
			showToast("Reply status must be a whole number between 100 and 599", "error");
			return null;
		}
		const delayMs = Number(delayDraft);
		if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_RESPONSE_DELAY_MS) {
			showToast(
				`Reply delay must be a whole number of milliseconds between 0 and ${MAX_RESPONSE_DELAY_MS}`,
				"error"
			);
			return null;
		}

		// A Map, not an object literal, so a header literally named `__proto__`
		// is a header rather than an assignment nobody meant.
		const headers = new Map<string, string>();
		for (const row of headerRows) {
			const name = row.key.trim();
			// A wholly blank row is the table's trailing spare, or one the user
			// added and did not fill; a value with no name is an edit that would
			// silently go nowhere, since the engine keys headers by name.
			if (name === "" && row.value === "") continue;
			if (name === "") {
				showToast("A reply header needs a name", "error");
				return null;
			}
			if (headers.has(name)) {
				showToast(`Reply header "${name}" is set twice`, "error");
				return null;
			}
			headers.set(name, row.value);
		}

		// Sent whole, not as a diff. The route is a merge-patch, so an omitted
		// `headers` would keep the served set - which is exactly how a removed
		// header would come back on the next apply.
		return { status, delayMs, body: bodyDraft, headers: Object.fromEntries(headers) };
	};

	const apply = () => {
		const next = collect();
		if (next) onApply(next);
	};

	const headerCount = headerRows.filter((row) => row.key.trim() !== "").length;

	return (
		<Collapsible
			open={detailsOpen}
			onOpenChange={setDetailsOpen}
			className="border-b border-border"
		>
			<div className="flex flex-wrap items-end gap-3 px-3 py-2">
				<div className="flex flex-col gap-1">
					<Label htmlFor="inbox-status" className="text-xs">
						Reply status
					</Label>
					<Input
						id="inbox-status"
						className="h-7 w-24 font-mono text-xs"
						value={statusDraft}
						disabled={disabled}
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
						disabled={disabled}
						onChange={(e) => setDelayDraft(e.target.value)}
					/>
				</div>

				<CollapsibleTrigger asChild>
					<Button variant="ghost" size="sm" className="h-7">
						<ChevronDown
							className={cn(
								"mr-2 h-3.5 w-3.5 transition-transform",
								detailsOpen && "rotate-180"
							)}
							aria-hidden="true"
						/>
						{`Body and headers${headerCount > 0 ? ` (${headerCount})` : ""}`}
					</Button>
				</CollapsibleTrigger>

				<Button variant="outline" size="sm" onClick={apply} disabled={disabled}>
					Apply
				</Button>

				{/* The set exists to test a sender's retry and error handling; saying
				    so is cheaper than a doc nobody opens mid-debug. On a stopped
				    inbox it says the other thing - that none of this is being
				    served - because the controls above would otherwise read as an
				    inbox waiting for callers it can no longer receive. */}
				<p className="text-xs text-muted-foreground">
					{stopped
						? "This inbox is stopped, so nothing is being served. Start a new one to change what callers receive."
						: "What every caller receives - a 500 with a delay exercises their retries."}
				</p>
			</div>

			<CollapsibleContent>
				<div className="flex flex-col gap-3 px-3 pb-3">
					<div className="flex flex-col gap-1">
						<Label htmlFor="inbox-body" className="text-xs">
							Reply body
						</Label>
						<Textarea
							id="inbox-body"
							className="min-h-16 font-mono text-xs"
							value={bodyDraft}
							disabled={disabled}
							placeholder="Sent verbatim - the reply's Content-Type is a header, below."
							onChange={(e) => setBodyDraft(e.target.value)}
						/>
					</div>

					<div className="flex flex-col gap-1">
						<span className="text-xs font-medium">Reply headers</span>
						{/*
						 * No `allowDisable`: a canned header is either in the set the
						 * engine serves or it is not, and a third "present but off"
						 * state would be a row the panel keeps and the reply never
						 * carries. Removing the row is the whole vocabulary.
						 */}
						<KeyValueEditor
							items={headerRows}
							onChange={setHeaderRows}
							keyPlaceholder="Name"
							valuePlaceholder="Value"
							allowDisable={false}
							readOnly={disabled}
						/>
					</div>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

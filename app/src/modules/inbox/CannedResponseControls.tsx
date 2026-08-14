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
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import {
	Button,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	Input,
	Label,
	Textarea,
} from "@/components/ui";
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

/** One header draft. `id` keys the row across edits; the name may still be blank. */
interface HeaderDraft {
	id: number;
	name: string;
	value: string;
}

function toDrafts(headers: Record<string, string>): HeaderDraft[] {
	return Object.entries(headers).map(([name, value], index) => ({ id: index, name, value }));
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
	const [headerDrafts, setHeaderDrafts] = useState<HeaderDraft[]>(() =>
		toDrafts(response.headers)
	);
	// Open when there is something to see: a configured body or header set is
	// part of what the inbox answers with, and a reader who has to go looking
	// for it is the defect this fixes.
	const [detailsOpen, setDetailsOpen] = useState(
		response.body !== "" || Object.keys(response.headers).length > 0
	);

	const disabled = stopped || pending;

	const updateHeader = (id: number, field: "name" | "value", next: string) =>
		setHeaderDrafts((drafts) =>
			drafts.map((draft) => (draft.id === id ? { ...draft, [field]: next } : draft))
		);

	const addHeader = () =>
		setHeaderDrafts((drafts) => [
			...drafts,
			{
				id: drafts.reduce((max, draft) => Math.max(max, draft.id), -1) + 1,
				name: "",
				value: "",
			},
		]);

	const removeHeader = (id: number) =>
		setHeaderDrafts((drafts) => drafts.filter((draft) => draft.id !== id));

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
		for (const draft of headerDrafts) {
			const name = draft.name.trim();
			// A wholly blank row is a row the user added and did not fill; a value
			// with no name is an edit that would silently go nowhere, since the
			// engine keys headers by name.
			if (name === "" && draft.value === "") continue;
			if (name === "") {
				showToast("A reply header needs a name", "error");
				return null;
			}
			if (headers.has(name)) {
				showToast(`Reply header "${name}" is set twice`, "error");
				return null;
			}
			headers.set(name, draft.value);
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

	const headerCount = headerDrafts.filter((draft) => draft.name.trim() !== "").length;

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
						{headerDrafts.map((draft) => (
							<div key={draft.id} className="flex items-center gap-2">
								<Input
									className="h-7 flex-1 font-mono text-xs"
									value={draft.name}
									disabled={disabled}
									placeholder="Name"
									aria-label={`Reply header ${draft.id + 1} name`}
									onChange={(e) => updateHeader(draft.id, "name", e.target.value)}
								/>
								<Input
									className="h-7 flex-1 font-mono text-xs"
									value={draft.value}
									disabled={disabled}
									placeholder="Value"
									aria-label={`Reply header ${draft.id + 1} value`}
									onChange={(e) =>
										updateHeader(draft.id, "value", e.target.value)
									}
								/>
								<Button
									variant="ghost"
									size="sm"
									className="h-7 px-2"
									disabled={disabled}
									aria-label={`Remove reply header ${draft.id + 1}`}
									onClick={() => removeHeader(draft.id)}
								>
									<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
								</Button>
							</div>
						))}
						<Button
							variant="ghost"
							size="sm"
							className="h-7 self-start"
							disabled={disabled}
							onClick={addHeader}
						>
							<Plus className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
							Add header
						</Button>
					</div>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

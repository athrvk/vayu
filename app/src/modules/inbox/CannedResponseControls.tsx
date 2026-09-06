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
import KeyValueEditor from "@/components/shared/KeyValueEditor";
import { toKeyValueItems } from "@/components/shared/KeyValueEditor/key-value";
import type { InboxCannedResponse, KeyValueItem } from "@/types";
import { useDraftSaveContext } from "@/hooks";
import { useSaveStore, useToastStore } from "@/stores";
import { cn } from "@/lib/utils";
import { STANDARD_HEADERS } from "@/constants/http";

/**
 * One inbox tab exists at a time (see the file this exports into), so one
 * static id names the reply's save context - there is never a second canned
 * response registered under it to collide with.
 */
const INBOX_REPLY_SAVE_CONTEXT = "inbox-reply";

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

/**
 * The header rows as a plain object, for comparing a draft against what the
 * engine last served - not for applying, which is `collect`'s job and
 * additionally refuses a blank name or a name set twice. A row with either of
 * those problems still counts toward dirtiness: the point is "does this
 * differ from what was served", not "is this valid to send".
 */
function draftHeaders(rows: KeyValueItem[]): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const row of rows) {
		const name = row.key.trim();
		if (name === "" && row.value === "") continue;
		headers[name] = row.value;
	}
	return headers;
}

function headersEqual(a: Record<string, string>, b: Record<string, string>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
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
	/** Rejecting is how a failed apply is reported - see `persist` below. */
	onApply: (response: Partial<InboxCannedResponse>) => Promise<void>;
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

	const startSaving = useSaveStore((s) => s.startSaving);
	const completeSaveThenIdle = useSaveStore((s) => s.completeSaveThenIdle);
	const failSave = useSaveStore((s) => s.failSave);

	const disabled = stopped || pending;

	// The visible "applied" state: true the moment any field diverges from what
	// the engine last served, false once it matches again - which happens on its
	// own after a successful apply, since the parent remounts this component on
	// the served response (see the file comment on why that is a remount and not
	// an effect).
	const isDirty =
		statusDraft !== String(response.status) ||
		delayDraft !== String(response.delayMs) ||
		bodyDraft !== response.body ||
		!headersEqual(draftHeaders(headerRows), response.headers);

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

	/**
	 * Reports through the save store rather than a bare toast (issue #1450): a
	 * refused apply calls `failSave`, which is both the app's one save-failure
	 * seam and how the Dock's error state gets shown, and a landed one clears
	 * through `completeSaveThenIdle` the same way every other explicit save
	 * does. Registered below as this reply's save, so this same function is
	 * what a quit flush or Ctrl/Cmd+S runs - `useDraftSaveContext` wraps it in
	 * its own `failSave` catch, which never fires here since this already
	 * resolves instead of throwing.
	 */
	const persist = async () => {
		const next = collect();
		if (!next) return;
		startSaving();
		try {
			await onApply(next);
			completeSaveThenIdle(INBOX_REPLY_SAVE_CONTEXT);
		} catch (error) {
			failSave(error instanceof Error ? error.message : "Could not update the response");
		}
	};

	useDraftSaveContext({
		id: INBOX_REPLY_SAVE_CONTEXT,
		name: "Inbox reply",
		isDirty,
		// The inbox tab's content only mounts while it is the active tab (see
		// `Shell.tsx`'s `renderTabContent`), so whenever this is mounted it is
		// the one a quit flush or Ctrl/Cmd+S should reach.
		isActive: true,
		save: persist,
	});

	const applyDisabled = disabled || !isDirty;

	const headerCount = headerRows.filter((row) => row.key.trim() !== "").length;

	return (
		<Collapsible
			open={detailsOpen}
			onOpenChange={setDetailsOpen}
			className="border-b border-border"
		>
			<div className="px-3 py-2">
				<div className="flex flex-wrap items-end gap-3">
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

					<Button
						variant="outline"
						size="sm"
						onClick={() => void persist()}
						disabled={applyDisabled}
					>
						Apply
					</Button>
				</div>

				{/* Stacked under the row, not sharing it (docs/design-system.md's
				    hint rule): a wrapping row would hand its width to this text and
				    pin the shorter control wherever the wrap put it. The set exists
				    to test a sender's retry and error handling; saying so is cheaper
				    than a doc nobody opens mid-debug. On a stopped inbox it says the
				    other thing - that none of this is being served - because the
				    controls above would otherwise read as an inbox waiting for
				    callers it can no longer receive. */}
				<p className="text-xs text-muted-foreground mt-1.5">
					{stopped
						? "This inbox is stopped, so nothing is being served. Start a new one to change what callers receive."
						: "Every caller to this inbox gets this reply. Apply sends the changes to the engine; the Dock reports the save."}
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
							keySuggestions={STANDARD_HEADERS}
						/>
					</div>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

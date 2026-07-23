/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SaveRunToRequestDialog
 *
 * Confirms copying a stored run's values back onto the request it came from.
 * It asks first because it cannot be undone - the request's current values are
 * simply replaced.
 *
 * The body is one uniform changeset: every field is a row, told apart only by
 * its state marker - `~` changed, `-` removed, `+` added, `=` kept. There is no
 * separate "unchanged" section. Auth and scripts are rows like headers and
 * params; a field the run cannot write back (auth always, a legacy run's
 * scripts) is a `=` kept row with its reason inline, at the same weight as
 * everything else.
 *
 * Structurally this follows `DeleteConfirmDialog`: same `Dialog` primitives and
 * focus redirected to Cancel on open, so a reflexive Enter backs out rather than
 * overwrites.
 */

import { useRef, useState } from "react";
import { Loader2, ArrowRight, ChevronRight } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
	Button,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils";
import { useUpdateRequestMutation } from "@/queries";
import { useToastStore } from "@/stores";
import type { Request, Run } from "@/types";
import type { DesignRunSeed } from "./design-run-seed";
import {
	buildChangeset,
	applyRunToRequest,
	type ChangeState,
	type ChangesetItem,
	type ChangesetEntry,
	type DiffSeg,
} from "./save-run-to-request";

interface SaveRunToRequestDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	seed: DesignRunSeed;
	run: Run;
	liveRequest: Request;
}

/** Glyph, text colour and stripe colour per state - all Vayu tokens. */
const STATE_STYLE: Record<ChangeState, { glyph: string; text: string; stripe: string }> = {
	changed: { glyph: "~", text: "text-warning-text", stripe: "bg-status-warning" },
	removed: { glyph: "-", text: "text-status-error-text", stripe: "bg-status-error" },
	added: { glyph: "+", text: "text-status-success-text", stripe: "bg-status-success" },
	kept: { glyph: "=", text: "text-muted-foreground", stripe: "bg-muted-foreground/40" },
};

/** A value diff: shared parts muted, removed struck red, added green. */
function Segments({ segments }: { segments: DiffSeg[] }) {
	return (
		<>
			{segments.map((s, i) => (
				<span
					key={i}
					className={cn(
						"break-all",
						s.kind === "same" && "text-muted-foreground",
						s.kind === "del" && "text-status-error-text line-through",
						s.kind === "add" && "text-status-success-text"
					)}
				>
					{s.text}
				</span>
			))}
		</>
	);
}

/** One key within a Headers/Params row, with its own add/remove/change marker. */
function EntryLine({ entry }: { entry: ChangesetEntry }) {
	const style = STATE_STYLE[entry.kind];
	return (
		<div className="flex flex-wrap items-baseline gap-1.5">
			<span className={cn("shrink-0 font-bold", style.text)}>{style.glyph}</span>
			{entry.kind === "changed" ? (
				<>
					<span className="text-foreground break-all">{entry.key}</span>
					<Segments segments={entry.segments ?? []} />
				</>
			) : entry.kind === "added" ? (
				<>
					<span className="text-foreground break-all">{entry.key}</span>
					<span className="text-muted-foreground break-all">{entry.value}</span>
				</>
			) : (
				<>
					<span className="text-muted-foreground line-through break-all">
						{entry.key}
					</span>
					<span className="text-muted-foreground line-through break-all">
						{entry.value}
					</span>
				</>
			)}
		</div>
	);
}

/** The value line under a row's header, chosen by which carrier the item has. */
function ItemValue({ item }: { item: ChangesetItem }) {
	if (item.entries) {
		return (
			<div className="mt-1.5 space-y-1 pl-[18px] font-mono text-[11px] leading-relaxed">
				{item.entries.map((e) => (
					<EntryLine key={`${e.kind}-${e.key}`} entry={e} />
				))}
			</div>
		);
	}
	if (item.segments) {
		return (
			<div className="mt-1.5 pl-[18px] font-mono text-[11px] leading-relaxed break-all">
				<Segments segments={item.segments} />
			</div>
		);
	}
	// kept: a plain mode, or a drift, then the reason.
	return (
		<div className="mt-1 pl-[18px]">
			<span className="font-mono text-[11px]">
				{item.driftFrom !== undefined ? (
					<>
						<span className="text-muted-foreground">{item.driftFrom}</span>
						<ArrowRight className="mx-1 inline h-3 w-3 text-muted-foreground align-middle" />
						<span className="text-foreground">{item.driftTo}</span>
					</>
				) : (
					<span className="text-foreground">{item.value}</span>
				)}
			</span>
			{item.note && (
				<span className="ml-2 text-[11px] text-muted-foreground">{item.note}</span>
			)}
		</div>
	);
}

/** One field row. A collapsible field (a script) opens its diff on demand. */
function ChangeRow({ item }: { item: ChangesetItem }) {
	const style = STATE_STYLE[item.state];
	const marker = (
		<span className={cn("w-2.5 shrink-0 text-center font-mono text-xs font-bold", style.text)}>
			{style.glyph}
		</span>
	);
	const header = (
		<div className="flex items-baseline gap-2">
			{marker}
			<span className="text-xs font-medium text-foreground">{item.field}</span>
			<span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
				{item.detail}
				{item.collapsible && (
					<ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
				)}
			</span>
		</div>
	);

	// stripe: an inset severity rail, colour by state.
	const stripe = (
		<span
			className={cn(
				"absolute left-2 top-[11px] bottom-[11px] w-0.5 rounded-full",
				style.stripe
			)}
		/>
	);

	if (item.collapsible) {
		return (
			<details className="group relative border-t border-rule py-2.5 pl-5 pr-3 first:border-t-0">
				{stripe}
				<summary className="cursor-pointer list-none outline-none focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
					{header}
				</summary>
				<ItemValue item={item} />
			</details>
		);
	}
	return (
		<div className="relative border-t border-rule py-2.5 pl-5 pr-3 first:border-t-0">
			{stripe}
			{header}
			<ItemValue item={item} />
		</div>
	);
}

export default function SaveRunToRequestDialog({
	open,
	onOpenChange,
	seed,
	run,
	liveRequest,
}: SaveRunToRequestDialogProps) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const [isSaving, setIsSaving] = useState(false);
	const updateRequestMutation = useUpdateRequestMutation();
	const showToast = useToastStore((s) => s.showToast);

	const items = buildChangeset(seed, liveRequest);
	const writable = items.filter((i) => i.state !== "kept");
	const counts: Record<ChangeState, number> = { changed: 0, removed: 0, added: 0, kept: 0 };
	for (const item of items) counts[item.state]++;

	const handleConfirm = async () => {
		setIsSaving(true);
		try {
			await updateRequestMutation.mutateAsync(applyRunToRequest(seed, liveRequest));
			showToast("Request updated from this run", "success");
			onOpenChange(false);
		} catch (error) {
			showToast(
				error instanceof Error ? error.message : "Could not update the request",
				"error"
			);
		} finally {
			setIsSaving(false);
		}
	};

	// Order the tally the way the markers read, skipping empty states.
	const tally = (["changed", "removed", "added", "kept"] as ChangeState[])
		.filter((s) => counts[s] > 0)
		.map((s) => ({ state: s, n: counts[s], ...STATE_STYLE[s] }));

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
			<DialogContent
				className="sm:max-w-xl"
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					cancelRef.current?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>Save run to {liveRequest.name || "the request"}</DialogTitle>
					<DialogDescription>
						Recorded {formatRelativeTime(new Date(run.startTime).toISOString())}. This
						replaces the request's current values.
					</DialogDescription>
				</DialogHeader>

				{tally.length > 0 && (
					<div className="flex flex-wrap gap-3 font-mono text-[11px] tabular-nums">
						{tally.map((t) => (
							<span key={t.state} className="text-muted-foreground">
								<span className={cn("font-bold", t.text)}>{t.glyph}</span> {t.n}{" "}
								{t.state}
							</span>
						))}
					</div>
				)}

				<div className="max-h-[24rem] overflow-y-auto surface-sunken rounded-md">
					{writable.length === 0 && (
						<p className="px-4 py-3 text-xs text-muted-foreground">
							The request already matches this run. Only fields the run cannot write
							are shown below.
						</p>
					)}
					{items.map((item) => (
						<ChangeRow key={item.field} item={item} />
					))}
				</div>

				<DialogFooter className="items-center gap-2 sm:gap-0">
					<span className="mr-auto text-[11px] text-muted-foreground">
						Cannot be undone
					</span>
					<Button
						ref={cancelRef}
						variant="secondary"
						onClick={() => onOpenChange(false)}
						disabled={isSaving}
					>
						Cancel
					</Button>
					<Button
						variant="default"
						onClick={handleConfirm}
						disabled={isSaving || writable.length === 0}
					>
						{isSaving ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							"Save to request"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

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
 * Structurally this follows `DeleteConfirmDialog`: same `Dialog` primitives,
 * same footer, and focus redirected to Cancel on open so a reflexive Enter
 * backs out rather than overwrites. It is a separate component rather than a
 * `DeleteConfirmDialog` with a long `description` because the body is a table
 * of changes plus a list of exclusions, and `DialogDescription` renders a `<p>`
 * - nesting that markup inside it is invalid HTML.
 *
 * The two lists matter equally. "Will change" is the diff; "left unchanged"
 * names what Save deliberately does not touch, and for a run stored before
 * per-part scripts that list is longer. Showing it is what makes an older run
 * writing fewer fields visible instead of surprising.
 */

import { useRef, useState } from "react";
import { Loader2, ArrowRight } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
	Button,
} from "@/components/ui";
import { formatRelativeTime } from "@/utils";
import { useUpdateRequestMutation } from "@/queries";
import { useToastStore } from "@/stores";
import type { Request, Run } from "@/types";
import type { DesignRunSeed } from "./design-run-seed";
import {
	diffRunAgainstRequest,
	applyRunToRequest,
	excludedFromSave,
	type EntryChange,
} from "./save-run-to-request";

/**
 * A scalar field's before -> after. Wraps rather than truncates: the point of
 * the diff is to be read, and the old dialog cut both sides to a shared line so
 * neither value was legible.
 */
function ScalarDiff({ from, to }: { from?: string; to?: string }) {
	return (
		<div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
			<span className="text-muted-foreground line-through break-all">{from || "none"}</span>
			<ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
			<span className="text-foreground break-all">{to || "none"}</span>
		</div>
	);
}

/**
 * A key/value field's per-key diff. Only the keys that differ appear; each names
 * whether it was added, removed or changed, with full values that wrap. The
 * marker colour uses the added/removed status tokens, not raw palette.
 */
function EntryDiff({ entries }: { entries: EntryChange[] }) {
	return (
		<ul className="m-0 mt-0.5 list-none space-y-0.5 p-0 font-mono text-[11px]">
			{entries.map((e) => (
				<li key={`${e.kind}-${e.key}`} className="flex flex-wrap items-baseline gap-1.5">
					{e.kind === "added" && (
						<>
							<span className="shrink-0 text-status-success-text">+</span>
							<span className="text-foreground break-all">{e.key}</span>
							<span className="text-muted-foreground break-all">{e.to}</span>
						</>
					)}
					{e.kind === "removed" && (
						<>
							<span className="shrink-0 text-status-error-text">-</span>
							<span className="text-muted-foreground line-through break-all">
								{e.key}
							</span>
							<span className="text-muted-foreground line-through break-all">
								{e.from}
							</span>
						</>
					)}
					{e.kind === "changed" && (
						<>
							<span className="shrink-0 text-muted-foreground">~</span>
							<span className="text-foreground break-all">{e.key}</span>
							<span className="text-muted-foreground line-through break-all">
								{e.from}
							</span>
							<ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
							<span className="text-foreground break-all">{e.to}</span>
						</>
					)}
				</li>
			))}
		</ul>
	);
}

interface SaveRunToRequestDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	seed: DesignRunSeed;
	run: Run;
	liveRequest: Request;
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

	const changes = diffRunAgainstRequest(seed, liveRequest);
	const excluded = excludedFromSave(seed);

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

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
			<DialogContent
				className="sm:max-w-lg"
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					cancelRef.current?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>Save this run to {liveRequest.name || "the request"}?</DialogTitle>
					<DialogDescription>
						This replaces the request's current values with the ones recorded{" "}
						{formatRelativeTime(new Date(run.startTime).toISOString())}. Anything you
						have changed since will be lost, and this cannot be undone.
					</DialogDescription>
				</DialogHeader>

				<div className="max-h-72 overflow-y-auto surface-sunken rounded-md p-3 space-y-4">
					{changes.length > 0 && (
						<p className="m-0 text-xs text-muted-foreground">
							Saving updates{" "}
							<span className="font-medium text-foreground">
								{changes.length} {changes.length === 1 ? "field" : "fields"}
							</span>
							{excluded.length > 0 && (
								<>
									{" "}
									and leaves{" "}
									<span className="font-medium text-foreground">
										{excluded.length}
									</span>{" "}
									unchanged
								</>
							)}
							.
						</p>
					)}

					<section>
						<h3 className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground mb-1.5">
							Will change
						</h3>
						{changes.length === 0 ? (
							<p className="m-0 text-xs text-muted-foreground">
								Nothing - the request already matches this run.
							</p>
						) : (
							<ul className="m-0 p-0 list-none space-y-2">
								{changes.map((change, i) => (
									<li
										key={change.field}
										className={
											i !== changes.length - 1
												? "border-b border-rule pb-2"
												: ""
										}
									>
										<div className="flex items-baseline justify-between gap-2">
											<span className="text-xs font-medium text-foreground">
												{change.field}
											</span>
											{change.entries && (
												<span className="text-[10px] text-muted-foreground">
													{change.entries.length}{" "}
													{change.entries.length === 1
														? "change"
														: "changes"}
												</span>
											)}
										</div>
										{change.entries ? (
											<EntryDiff entries={change.entries} />
										) : (
											<ScalarDiff from={change.from} to={change.to} />
										)}
									</li>
								))}
							</ul>
						)}
					</section>

					<section>
						<h3 className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground mb-1.5">
							Left unchanged
						</h3>
						<ul className="m-0 p-0 list-none space-y-1.5">
							{excluded.map((item) => (
								<li key={item.field}>
									<span className="text-xs font-medium text-foreground">
										{item.field}
									</span>
									<p className="m-0 text-[11px] text-muted-foreground">
										{item.reason}
									</p>
								</li>
							))}
						</ul>
					</section>
				</div>

				<DialogFooter className="gap-2 sm:gap-0">
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
						disabled={isSaving || changes.length === 0}
					>
						{isSaving ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
							"Save to request"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

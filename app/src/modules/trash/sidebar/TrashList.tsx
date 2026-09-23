/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

import { useToastStore } from "@/stores";
import { useRemovalRefocus } from "@/hooks/useRemovalRefocus";
import {
	useTrashQuery,
	useRestoreTrashMutation,
	usePurgeTrashMutation,
	useConfigQuery,
} from "@/queries";
import { DrawerPanel, EmptyState, ErrorState, ListSkeleton } from "@/components/shared";
import { Button, DeleteConfirmDialog } from "@/components/ui";
import TrashItem from "./TrashItem";
import { retentionCopy, retentionDaysFrom } from "../retention";
import { restoreNotice } from "../restore-notice";
import type { TrashEntry } from "@/types";

export default function TrashList() {
	const showToast = useToastStore((s) => s.showToast);

	const { data, isLoading, isError, error, refetch } = useTrashQuery();
	const restoreMutation = useRestoreTrashMutation();
	const purgeMutation = usePurgeTrashMutation();

	/*
	 * The retention window comes from the config the Settings panel already
	 * fetches, so this costs a cache read rather than a request - and it stays
	 * right when the user changes the setting, because the update mutation
	 * writes that same cache.
	 */
	const { data: config } = useConfigQuery();
	const retention = retentionCopy(retentionDaysFrom(config?.entries));

	const [restoringId, setRestoringId] = useState<string | null>(null);
	const [purgingId, setPurgingId] = useState<string | null>(null);
	const [purgeTarget, setPurgeTarget] = useState<TrashEntry | null>(null);
	const [confirmEmptyOpen, setConfirmEmptyOpen] = useState(false);
	const [isEmptying, setIsEmptying] = useState(false);

	const listRef = useRef<HTMLDivElement>(null);

	// Memoised because the refocus effect below depends on it: `?? []` is a fresh
	// array on every render while the query has no data.
	const entries = useMemo(() => data?.items ?? [], [data]);

	/*
	 * Gated on there being nothing cached, the way HistoryList gates its own:
	 * TanStack keeps the last good list through a failed background refetch, and
	 * a list that is still correct should not be replaced by an error pane.
	 */
	const showError = isError && entries.length === 0;

	const handleRestore = async (entry: TrashEntry) => {
		setRestoringId(entry.id);
		try {
			const restored = await restoreMutation.mutateAsync(entry.id);
			// Shared with the undo toast's restore, so the same outcome is
			// explained the same way whichever button performed it.
			const notice = restoreNotice(restored, entry.name);
			if (notice) showToast({ message: notice, variant: "info" });
		} catch (err) {
			/*
			 * The engine's refusals are specific and worth repeating verbatim: a
			 * request whose collection is itself in the trash is a 409 naming
			 * that collection ("restore that first"), which tells the user
			 * exactly what to do next. Wording invented here could not.
			 */
			showToast(
				err instanceof Error ? err.message : `Couldn't restore "${entry.name}"`,
				"error"
			);
		} finally {
			setRestoringId(null);
		}
	};

	const handleConfirmPurge = async () => {
		if (!purgeTarget) return;
		const target = purgeTarget;
		setPurgeTarget(null);
		setPurgingId(target.id);
		try {
			await purgeMutation.mutateAsync(target.id);
		} catch (err) {
			showToast(
				err instanceof Error ? err.message : `Couldn't delete "${target.name}"`,
				"error"
			);
		} finally {
			setPurgingId(null);
		}
	};

	/**
	 * Empty trash (issue #1689): the panel-header counterpart to per-row purge.
	 *
	 * No bulk-purge engine route exists (checked against `engine/CLAUDE.md`'s
	 * HTTP API contract), and the owner's #1683 decision rules out adding one for
	 * a client-only convenience - so this loops the same per-row mutation the
	 * rows already use, one at a time rather than in parallel: the trash and the
	 * engine's file moves behind it are not built for concurrent purges of the
	 * same list, and a serial loop is the one shape that is definitely safe. A
	 * row that fails is reported and skipped, not retried, so one stuck entry
	 * cannot block the rest.
	 */
	const handleEmptyTrash = async () => {
		const targets = entries;
		setConfirmEmptyOpen(false);
		if (targets.length === 0) return;
		setIsEmptying(true);
		let failures = 0;
		try {
			for (const entry of targets) {
				try {
					await purgeMutation.mutateAsync(entry.id);
				} catch {
					failures++;
				}
			}
		} finally {
			setIsEmptying(false);
		}
		if (failures > 0) {
			showToast(
				failures === targets.length
					? "Couldn't empty the trash"
					: `Couldn't delete ${failures} of ${targets.length} items`,
				"error"
			);
		}
	};

	/*
	 * A purge dialog is controlled with no trigger, so Radix's close-focus has
	 * nowhere to land and the row it was opened from is about to go (#1234). The
	 * list is flat, so the rule is simply the next row, or the one before it when
	 * the purged row was last - and, as in the tree, the move waits for the row
	 * to actually leave, which here is always after the dialog has closed: this
	 * dialog closes before the purge is even sent.
	 */
	const { capture, onCloseAutoFocus } = useRemovalRefocus();

	useEffect(() => {
		if (!purgeTarget) return;
		const rowFor = (id: string) =>
			listRef.current?.querySelector<HTMLElement>(`[data-trash-id="${CSS.escape(id)}"]`) ??
			null;
		const index = entries.findIndex((entry) => entry.id === purgeTarget.id);
		const successor = index === -1 ? undefined : (entries[index + 1] ?? entries[index - 1]);

		capture({
			doomed: () => rowFor(purgeTarget.id),
			// Purging the last entry leaves no row to move to, and Trash has no
			// create control to fall back on the way the trees do - so focus goes
			// to the list itself, which is still there holding the empty state.
			successor: () => (successor ? rowFor(successor.id) : listRef.current),
			focus: (row) => row.focus(),
		});
	}, [capture, entries, purgeTarget]);

	return (
		<DrawerPanel
			title="Trash"
			actions={
				entries.length > 0 ? (
					<>
						<span className="text-xs text-muted-foreground shrink-0">
							{entries.length} {entries.length === 1 ? "item" : "items"}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setConfirmEmptyOpen(true)}
							disabled={isEmptying}
						>
							Empty trash
						</Button>
					</>
				) : undefined
			}
		>
			<div className="flex h-full w-full flex-col gap-3 px-3 pt-2 pb-3">
				{retention && entries.length > 0 && (
					<p className="shrink-0 text-xs text-muted-foreground">{retention}</p>
				)}

				<div className="flex-1 min-h-0 overflow-hidden">
					{/* tabIndex -1: not a tab stop in front of the rows, but a target
					    focus can be *put* on - where it goes when the purged row was
					    the last one there was. */}
					<div
						ref={listRef}
						data-trash-list
						tabIndex={-1}
						className="h-full space-y-2 overflow-y-auto pr-1"
					>
						{isLoading && <ListSkeleton rows={4} leading />}

						{!isLoading && showError && (
							// `h-full` rather than the pane variant's `flex-1`: the
							// parent is a scroll container, not a flex column.
							<ErrorState
								className="h-full"
								title="Couldn't load the trash"
								detail={error instanceof Error ? error.message : undefined}
								onRetry={() => void refetch()}
							/>
						)}

						{!isLoading && !showError && entries.length === 0 && (
							<EmptyState
								className="h-full"
								icon={Trash2}
								title="Trash is empty"
								description={
									retention
										? `Deleted collections and requests wait here first. ${retention}`
										: // No promise of an eventual purge while the window
											// is still unknown: at `trashRetentionDays: 0` there
											// is no automatic removal to promise.
											"Deleted collections and requests wait here."
								}
							/>
						)}

						{!isLoading &&
							entries.map((entry) => (
								<TrashItem
									key={entry.id}
									entry={entry}
									onRestore={(e) => void handleRestore(e)}
									onPurge={setPurgeTarget}
									isRestoring={restoringId === entry.id}
									isPurging={purgingId === entry.id}
								/>
							))}
					</div>
				</div>

				<DeleteConfirmDialog
					open={!!purgeTarget}
					onOpenChange={(open) => !open && setPurgeTarget(null)}
					title="Delete forever?"
					name={purgeTarget?.name}
					scope={purgeTarget?.kind === "collection" ? "cascade" : "default"}
					confirmLabel="Delete forever"
					onConfirm={handleConfirmPurge}
					onCloseAutoFocus={onCloseAutoFocus}
					isDeleting={!!purgingId}
				/>

				<DeleteConfirmDialog
					open={confirmEmptyOpen}
					onOpenChange={setConfirmEmptyOpen}
					title="Empty trash?"
					description={`All ${entries.length} ${
						entries.length === 1 ? "item" : "items"
					} in the trash are removed permanently. This can't be undone.`}
					confirmLabel="Empty trash"
					onConfirm={() => void handleEmptyTrash()}
					isDeleting={isEmptying}
				/>
			</div>
		</DrawerPanel>
	);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import { Trash2 } from "lucide-react";

import { useToastStore } from "@/stores";
import {
	useTrashQuery,
	useRestoreTrashMutation,
	usePurgeTrashMutation,
	useConfigQuery,
} from "@/queries";
import { DrawerPanel, EmptyState, ErrorState, ListSkeleton } from "@/components/shared";
import { DeleteConfirmDialog } from "@/components/ui";
import TrashItem from "./TrashItem";
import { retentionCopy, retentionDaysFrom } from "../retention";
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

	const entries = data?.items ?? [];

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
			/*
			 * A collection whose parent is gone comes back at the top level
			 * instead of where it was. That is the engine moving the user's
			 * folder, and the only place they could learn it is here - the tree
			 * will simply show it somewhere new.
			 */
			if (restored.reparentedToRoot) {
				showToast({
					message: `Restored "${entry.name}" to the top level - the folder it was in is gone.`,
					variant: "info",
				});
			}
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

	const purgeDescription = purgeTarget
		? purgeTarget.kind === "collection"
			? `"${purgeTarget.name}" and everything inside it will be removed for good. This cannot be undone.`
			: `"${purgeTarget.name}" will be removed for good. This cannot be undone.`
		: "";

	return (
		<DrawerPanel
			title="Trash"
			actions={
				entries.length > 0 ? (
					<span className="text-xs text-muted-foreground shrink-0">
						{entries.length} {entries.length === 1 ? "item" : "items"}
					</span>
				) : undefined
			}
		>
			<div className="flex h-full w-full flex-col gap-3 px-3 pt-2 pb-3">
				{retention && entries.length > 0 && (
					<p className="shrink-0 text-xs text-muted-foreground">{retention}</p>
				)}

				<div className="flex-1 min-h-0 overflow-hidden">
					<div className="h-full space-y-2 overflow-y-auto pr-1">
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
										: "Deleted collections and requests wait here before they are removed for good."
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
					description={purgeDescription}
					confirmLabel="Delete forever"
					onConfirm={handleConfirmPurge}
					isDeleting={!!purgingId}
				/>
			</div>
		</DrawerPanel>
	);
}

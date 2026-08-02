/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback } from "react";

import { Button, Input, MarkdownEditor } from "@/components/ui";
import { useDraftSaveContext, useEntityDraft } from "@/hooks";
import { useUpdateCollectionMutation } from "@/queries/collections";
import type { Collection } from "@/types";
import { Field, SaveFailed, Stat } from "./shared";
import { formatRelative } from "./format";

interface InfoTabProps {
	collection: Collection;
	requestCount: number;
	/** Whether this is the tab on screen - see `useDraftSaveContext`. */
	active?: boolean;
}

interface InfoDraft {
	name: string;
	description: string;
}

export default function InfoTab({ collection, requestCount, active = false }: InfoTabProps) {
	const updateCollection = useUpdateCollectionMutation();

	// Draft/resync/isDirty/mutation-reset all live in the shared hook - the
	// three collection tabs used to hand-roll it one each, and this was the one
	// that forgot to clear the mutation on a collection switch. See
	// useEntityDraft.
	//
	// The resync also re-runs after a save (the props come back changed), which
	// clears the post-trim divergence: `handleSave` persists `name.trim()`, so
	// a draft with trailing whitespace would otherwise stay dirty against the
	// trimmed saved value forever.
	const {
		draft,
		setDraft,
		isDirty,
		reset: handleReset,
	} = useEntityDraft<InfoDraft>({
		entityKey: collection.id,
		value: { name: collection.name, description: collection.description ?? "" },
		mutation: updateCollection,
	});
	const { name, description } = draft;

	// A collection must keep a name, so a blank one is not saveable - and the
	// store-driven paths (Ctrl/Cmd+S, the quit flush) have no disabled button to
	// stop them, so the guard lives here rather than only on the button.
	const canSave = isDirty && name.trim().length > 0;

	const persist = useCallback(async () => {
		if (!canSave) return;
		await updateCollection.mutateAsync({
			id: collection.id,
			name: name.trim(),
			description,
		});
	}, [canSave, updateCollection, collection.id, name, description]);

	useDraftSaveContext({
		id: `collection-${collection.id}-info`,
		name: `Collection: ${collection.name}`,
		isDirty: canSave,
		isActive: active,
		save: persist,
	});

	// A rejection here is rendered by <SaveFailed> below; the store-driven paths
	// toast instead, since this callout may not be on screen at all.
	const handleSave = () => void persist().catch(() => {});

	return (
		<div className="max-w-[540px] flex flex-col gap-5">
			<Field label="Collection name">
				<Input
					value={name}
					onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
					className="text-sm font-medium"
				/>
			</Field>

			{/*
			 * This field has advertised "Markdown supported" beside a plain
			 * textarea for as long as it has existed - stored as markdown, rendered
			 * as never. It gets the same editor as a request's description: prose
			 * when you are reading, source when you click in.
			 *
			 * The hint is gone because the behaviour now says it. `onCommit` is
			 * omitted deliberately: this form saves explicitly through its Save
			 * Changes button, unlike the request builder which persists on blur.
			 */}
			<Field label="Description">
				<MarkdownEditor
					value={description}
					onChange={(value) => setDraft((d) => ({ ...d, description: value }))}
					/*
					 * A failed save means the stored text is not what is on
					 * screen, and rendering shows what is stored - so it would
					 * hide the edit behind a tidy view of the old value, directly
					 * above the `SaveFailed` notice telling you to try again.
					 */
					keepSourceOpen={updateCollection.isError}
					aria-label="Collection description"
					placeholder="Document this collection - what it covers, base URL, usage notes…"
					emptyHint="Document this collection… Markdown is rendered when you click away."
					minHeight="100px"
				/>
			</Field>

			<div className="h-px bg-border" />

			<div className="grid grid-cols-3 gap-2.5">
				<Stat label="Requests" value={String(requestCount)} />
				<Stat label="Created" value={formatRelative(collection.createdAt)} />
				<Stat label="Updated" value={formatRelative(collection.updatedAt)} />
			</div>

			<SaveFailed mutation={updateCollection} what="this collection" />

			<div className="flex gap-2">
				<Button
					onClick={handleSave}
					disabled={!canSave || updateCollection.isPending}
					className="font-semibold"
				>
					{updateCollection.isPending ? "Saving…" : "Save Changes"}
				</Button>
				<Button
					variant="outline"
					onClick={handleReset}
					disabled={!isDirty || updateCollection.isPending}
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}

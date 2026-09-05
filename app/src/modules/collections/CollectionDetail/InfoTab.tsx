/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The collection's own Info tab.
 *
 * **It used to demand an explicit Save.** Name and description sat behind
 * "Save Changes" / "Cancel" while the request builder - the surface you spend
 * the day in - persisted on blur. Two Info tabs with opposite save models is a
 * coherence bug: the same act on the same kind of field either sticks or does
 * not depending on which pane you are in. They are one model now, and it is the
 * builder's, because that is the one the app is mostly made of.
 *
 * Losing the buttons costs the blank-name guard its disabled state, so the
 * refusal is spoken instead - see `reportBlankNameRefused`. `SaveFailed` still
 * reports a *rejected* save, which is a different failure and still needs its
 * own surface.
 */

import { useCallback } from "react";

import { Input, MarkdownEditor } from "@/components/ui";
import { useDraftSaveContext, useEntityDraft } from "@/hooks";
import { reportBlankNameRefused } from "@/lib/blank-name";
import { useUpdateCollectionMutation } from "@/queries/collections";
import type { Collection } from "@/types";
import { ExternalChangeCallout, Field, SaveFailed, Stat } from "./shared";
import { formatRelative } from "./format";

interface InfoTabProps {
	collection: Collection;
	/**
	 * Requests in the collection's whole subtree, not the ones it owns directly
	 * (issue #723) - the count the shell computes for its header, so the two
	 * cannot disagree about what "Requests" names. See the rationale there.
	 */
	requestCount: number;
	/** Whether this is the tab on screen - see `useDraftSaveContext`. */
	active?: boolean;
}

interface InfoDraft {
	name: string;
	description: string;
}

/**
 * One field of the per-key merge #1437 needs: a field the user hasn't touched
 * adopts an external change; a field both sides changed, to different values,
 * is a conflict left at the user's own value until they choose.
 */
function mergeField<K extends keyof InfoDraft>(
	key: K,
	draft: InfoDraft,
	baseline: InfoDraft,
	externalValue: InfoDraft | null
): { value: InfoDraft[K]; conflict: boolean } {
	if (externalValue === null || externalValue[key] === baseline[key]) {
		return { value: draft[key], conflict: false };
	}
	const touched = draft[key] !== baseline[key];
	if (!touched || externalValue[key] === draft[key]) {
		return { value: touched ? draft[key] : externalValue[key], conflict: false };
	}
	return { value: draft[key], conflict: true };
}

export default function InfoTab({ collection, requestCount, active = false }: InfoTabProps) {
	const updateCollection = useUpdateCollectionMutation();

	// Draft/resync/isDirty/mutation-reset all live in the shared hook - the
	// three collection tabs used to hand-roll it one each, and this was the one
	// that forgot to clear the mutation on a collection switch. See
	// useEntityDraft.
	//
	// The resync also re-runs after a save (the props come back changed), which
	// clears the post-trim divergence: `persist` writes `name.trim()`, so a
	// draft with trailing whitespace would otherwise stay dirty against the
	// trimmed saved value forever.
	const { draft, setDraft, isDirty, baseline, externalValue } = useEntityDraft<InfoDraft>({
		entityKey: collection.id,
		value: { name: collection.name, description: collection.description ?? "" },
		mutation: updateCollection,
	});

	// Merged per key rather than as one value (#1437): a field the user has not
	// touched adopts an agent's change silently, the way a clean tab always
	// has; a field both sides touched is a conflict, named and left for the
	// user to resolve rather than picked for them.
	const nameMerge = mergeField("name", draft, baseline, externalValue);
	const descriptionMerge = mergeField("description", draft, baseline, externalValue);
	const { value: name, conflict: nameConflict } = nameMerge;
	const { value: description, conflict: descriptionConflict } = descriptionMerge;

	const takeTheirName = () => {
		if (externalValue) setDraft((d) => ({ ...d, name: externalValue.name }));
	};
	const takeTheirDescription = () => {
		if (externalValue) setDraft((d) => ({ ...d, description: externalValue.description }));
	};

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
	const commit = () => void persist().catch(() => {});

	/*
	 * Trim, then commit - or refuse and put the stored name back.
	 *
	 * `canSave` already stops a blank one reaching the engine, including from
	 * Ctrl/Cmd+S and the quit flush. What it cannot do is *say* anything: with
	 * the Save button gone there is no disabled control left to show the refusal,
	 * so the draft is reset to the stored name and the save channel reports it.
	 */
	const commitName = () => {
		const trimmed = name.trim();
		if (!trimmed) {
			setDraft((d) => ({ ...d, name: collection.name }));
			reportBlankNameRefused("collection");
			return;
		}
		if (trimmed !== name) setDraft((d) => ({ ...d, name: trimmed }));
		commit();
	};

	return (
		<div className="max-w-[540px] flex flex-col gap-5">
			{nameConflict && <ExternalChangeCallout what="name" onTakeTheirs={takeTheirName} />}
			{descriptionConflict && (
				<ExternalChangeCallout what="description" onTakeTheirs={takeTheirDescription} />
			)}

			<Field label="Collection name">
				<Input
					value={name}
					onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
					onBlur={commitName}
					// `Field`'s label is a styled div, not a `<label for>`, so the
					// input has no accessible name without this.
					aria-label="Collection name"
					className="text-sm font-medium"
				/>
			</Field>

			{/*
			 * This field has advertised "Markdown supported" beside a plain
			 * textarea for as long as it has existed - stored as markdown, rendered
			 * as never. It gets the same editor as a request's description: prose
			 * when you are reading, source when you click in.
			 *
			 * The hint is gone because the behaviour now says it. `onCommit` fires
			 * on the same blur that renders the markdown, which is what makes this
			 * form's save model the request builder's.
			 */}
			<Field label="Description">
				<MarkdownEditor
					value={description}
					onChange={(value) => setDraft((d) => ({ ...d, description: value }))}
					onCommit={commit}
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
		</div>
	);
}

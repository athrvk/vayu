/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Button, Input, Textarea } from "@/components/ui";
import { useEntityDraft } from "@/hooks";
import { useUpdateCollectionMutation } from "@/queries/collections";
import type { Collection } from "@/types";
import { Field, SaveFailed, Stat, formatRelative } from "./shared";

interface InfoTabProps {
	collection: Collection;
	requestCount: number;
}

interface InfoDraft {
	name: string;
	description: string;
}

export default function InfoTab({ collection, requestCount }: InfoTabProps) {
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

	const handleSave = () => {
		if (!isDirty || !name.trim()) return;
		updateCollection.mutate({
			id: collection.id,
			name: name.trim(),
			description,
		});
	};

	return (
		<div className="max-w-[540px] flex flex-col gap-5">
			<Field label="Collection name">
				<Input
					value={name}
					onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
					className="text-sm font-medium"
				/>
			</Field>

			<Field label="Description" hint="Markdown supported">
				<Textarea
					value={description}
					onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
					placeholder="Document this collection - what it covers, base URL, usage notes…"
					className="min-h-[100px] text-sm leading-relaxed resize-y"
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
					disabled={!isDirty || !name.trim() || updateCollection.isPending}
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

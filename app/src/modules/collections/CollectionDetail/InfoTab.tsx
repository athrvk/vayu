/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useState } from "react";
import { Button, Input, Textarea } from "@/components/ui";
import { useUpdateCollectionMutation } from "@/queries/collections";
import type { Collection } from "@/types";
import { Field, SaveFailed, Stat, formatRelative } from "./shared";

interface InfoTabProps {
	collection: Collection;
	requestCount: number;
}

export default function InfoTab({ collection, requestCount }: InfoTabProps) {
	const [name, setName] = useState(collection.name);
	const [description, setDescription] = useState(collection.description ?? "");
	const updateCollection = useUpdateCollectionMutation();

	// Resync the editable name/description drafts when the collection changes
	// (component renders inline, not remounted per-collection). Can't be derived:
	// these are user-editable drafts that diverge from props between edits and
	// save. The effect also re-runs after save (name/description props update),
	// which clears the post-trim divergence - `handleSave` persists `name.trim()`
	// so the local draft would otherwise stay dirty against the trimmed saved
	// value. A value-keyed render-phase reset would not preserve that resync.
	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setName(collection.name);
		setDescription(collection.description ?? "");
	}, [collection.id, collection.name, collection.description]);

	// The other half of that resync - see AuthTab. This component is reused
	// across collection switches, and a mutation holds `isError` until the next
	// mutate, so the failure notice has to be cleared with the drafts.
	const resetSave = updateCollection.reset;
	useEffect(() => {
		resetSave();
	}, [collection.id, resetSave]);

	const isDirty = name !== collection.name || description !== (collection.description ?? "");

	const handleSave = () => {
		if (!isDirty || !name.trim()) return;
		updateCollection.mutate({
			id: collection.id,
			name: name.trim(),
			description,
		});
	};

	const handleReset = () => {
		setName(collection.name);
		setDescription(collection.description ?? "");
	};

	return (
		<div className="max-w-[540px] flex flex-col gap-5">
			<Field label="Collection name">
				<Input
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="text-[13px] font-medium"
				/>
			</Field>

			<Field label="Description" hint="Markdown supported">
				<Textarea
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="Document this collection - what it covers, base URL, usage notes…"
					className="min-h-[100px] text-[13px] leading-relaxed resize-y"
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

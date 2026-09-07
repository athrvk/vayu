/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ElementsTab (issue #1512)
 *
 * Replaces the separate Pre-request and Post-request `ScriptTab`s with one
 * list of typed behaviours - extractors, assertions, timers and scripts -
 * bound to the collection's `elements` column through the shared
 * `ElementList` primitive.
 *
 * **A button, not a blur-commit, on the same basis as `AuthTab` (#446).**
 * `ScriptTab` committed on focus leaving its one `CodeEditor`, because a
 * script tab has exactly one focus stop and leaving it means you are done.
 * This tab is not one buffer: adding a kind, naming a row, toggling it,
 * reordering it and editing its form are all separate stops, and a script
 * element's own `CodeEditor` inside the list would fire the same
 * half-typed-value blur `AuthTab`'s doc comment measured. The fields only
 * make sense saved together, which is what the button means here too.
 */

import { useCallback } from "react";
import { Button } from "@/components/ui";
import { ExternalChangeCallout } from "@/components/shared";
import { ElementList } from "@/components/shared/ElementList";
import { useDraftSaveContext, useEntityDraft } from "@/hooks";
import { useUpdateCollectionMutation } from "@/queries/collections";
import { useElementKindsQuery } from "@/queries";
import type { Collection, ElementDef } from "@/types";
import { InfoBanner, SaveFailed } from "./shared";

interface ElementsTabProps {
	collection: Collection;
	/** Whether this is the tab on screen - see `useDraftSaveContext`. */
	active?: boolean;
}

export default function ElementsTab({ collection, active = false }: ElementsTabProps) {
	const updateCollection = useUpdateCollectionMutation();
	const { data: kinds } = useElementKindsQuery();

	const {
		draft: elements,
		setDraft: setElements,
		isDirty,
		reset: resetDraft,
		externalValue,
	} = useEntityDraft<ElementDef[]>({
		entityKey: `${collection.id}:elements`,
		value: collection.elements,
		mutation: updateCollection,
	});

	const persist = useCallback(async () => {
		if (!isDirty) return;
		await updateCollection.mutateAsync({ id: collection.id, elements });
	}, [isDirty, updateCollection, collection.id, elements]);

	useDraftSaveContext({
		id: `collection-${collection.id}-elements`,
		name: `Collection elements: ${collection.name}`,
		isDirty,
		isActive: active,
		save: persist,
	});

	const handleSave = () => void persist().catch(() => {});

	return (
		<div className="max-w-[680px] space-y-3.5">
			<InfoBanner>
				Elements set here run <strong>before and after every request</strong> in this
				collection. They compose outer→inner: the parent collection runs first, then child
				folders, then the request&apos;s own elements.
			</InfoBanner>

			{externalValue !== null && (
				<ExternalChangeCallout what="the elements list" onTakeTheirs={resetDraft} />
			)}

			<p className="text-[11px] text-muted-foreground">
				These are saved together, when you press Save Elements - not as you add or edit one.
			</p>

			<ElementList
				elements={elements}
				onChange={setElements}
				kinds={kinds ?? []}
				emptyLabel="No elements yet. Add an extractor, assertion, timer or script from the menu below."
			/>

			<SaveFailed mutation={updateCollection} what="the elements list" />

			<div className="flex gap-2">
				<Button
					onClick={handleSave}
					disabled={!isDirty || updateCollection.isPending}
					className="font-semibold"
				>
					{updateCollection.isPending ? "Saving…" : "Save Elements"}
				</Button>
				<Button
					variant="outline"
					onClick={resetDraft}
					disabled={!isDirty || updateCollection.isPending}
				>
					Reset
				</Button>
			</div>
		</div>
	);
}

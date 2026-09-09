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
 *
 * A `script.pre`/`script.post` row gets the "Names mentioned" chip row above
 * its editor (issue #1553), via `ElementList`'s `renderAboveForm` - the same
 * `useDataContract`/`useVariableResolver` pair the retired `ScriptTab` read
 * directly, since `ScriptElementForm` itself cannot depend on either.
 */

import { useCallback } from "react";
import { Button } from "@/components/ui";
import { ExternalChangeCallout, ScriptReferencesRow } from "@/components/shared";
import { ElementList } from "@/components/shared/ElementList";
import { useDataContract, useDraftSaveContext, useEntityDraft, useVariableResolver } from "@/hooks";
import { useUpdateCollectionMutation } from "@/queries/collections";
import { useElementKindsQuery } from "@/queries";
import { hasIncompleteElement, SaveBlockedError } from "@/lib/elements";
import type { Collection, ElementDef } from "@/types";
import { InfoBanner, SaveFailed } from "./shared";

/** How many referenced names get a chip before the rest become a count - the
 * collection tab's own, wider limit from before the migration (`ScriptTab`). */
const CHIP_LIMIT = 8;

interface ElementsTabProps {
	collection: Collection;
	/** Whether this is the tab on screen - see `useDraftSaveContext`. */
	active?: boolean;
}

export default function ElementsTab({ collection, active = false }: ElementsTabProps) {
	const updateCollection = useUpdateCollectionMutation();
	const { data: kinds } = useElementKindsQuery();
	const dataColumns = useDataContract(collection.id);
	const { getAllVariables, getVariableOrigins } = useVariableResolver({
		collectionId: collection.id,
	});

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

	const kindsList = kinds ?? [];
	const incomplete = hasIncompleteElement(elements, kindsList);

	const persist = useCallback(async () => {
		if (!isDirty) return;
		// Same whole-array 400 as the request builder's autosave (issue #1635):
		// this button is disabled while `incomplete`, but `useDraftSaveContext`
		// also registers `persist` for Cmd+S and the quit flush, neither of
		// which reads the disabled attribute - so the check has to live here
		// too, not only on the button below. Reads `kinds` directly (not
		// `kindsList`, a fresh `[]` reference on every render while the query is
		// still loading) so this callback's identity does not churn with it.
		if (hasIncompleteElement(elements, kinds ?? [])) throw new SaveBlockedError();
		await updateCollection.mutateAsync({ id: collection.id, elements });
	}, [isDirty, updateCollection, collection.id, elements, kinds]);

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
				kinds={kindsList}
				renderAboveForm={(element) => {
					if (element.kind !== "script.pre" && element.kind !== "script.post")
						return null;
					const script =
						typeof element.config.script === "string" ? element.config.script : "";
					return (
						<ScriptReferencesRow
							script={script}
							allVariables={getAllVariables()}
							getVariableOrigins={getVariableOrigins}
							dataColumns={dataColumns}
							chipLimit={CHIP_LIMIT}
						/>
					);
				}}
			/>

			<SaveFailed mutation={updateCollection} what="the elements list" />

			{incomplete && (
				<p className="text-xs text-muted-foreground">
					Finish the field an element marked &quot;Needs&quot; above is missing before
					saving.
				</p>
			)}

			<div className="flex gap-2">
				<Button
					onClick={handleSave}
					disabled={!isDirty || updateCollection.isPending || incomplete}
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

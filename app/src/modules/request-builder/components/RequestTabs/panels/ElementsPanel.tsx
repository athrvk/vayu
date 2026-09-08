/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ElementsPanel (issue #1512)
 *
 * The request builder's Elements tab: replaces the separate Pre-request and
 * Tests tabs with one list of typed behaviours. Binds the shared
 * `ElementList` primitive to `RequestState.elements`, shows what the
 * collection chain contributes above it (`InheritedElementsNotice`), and
 * keeps the legacy glued-script notice for a design run recorded before
 * script parts existed.
 */

import { useElementKindsQuery } from "@/queries";
import { ElementList } from "@/components/shared/ElementList";
import { useRequestBuilderContext } from "../../../context";
import InheritedElementsNotice from "./InheritedElementsNotice";
import LegacyScriptNotice from "./LegacyScriptNotice";

export default function ElementsPanel() {
	const { request, updateField, inheritedElements, legacyPreScript, legacyPostScript } =
		useRequestBuilderContext();
	const { data: kinds } = useElementKindsQuery();
	// `script.setup` / `script.teardown` are collection-only (issue #1499):
	// the engine refuses them on a request's own `elements`, so a request's
	// Add menu never offers them - `InheritedElementsNotice` below still shows
	// them when a collection above declares one, unfiltered, since that is
	// display rather than an offer to add.
	const addableKinds = (kinds ?? []).filter((kind) => !kind.collectionOnly);

	return (
		<div className="space-y-4">
			<InheritedElementsNotice
				collectionId={request.collectionId}
				entries={inheritedElements}
				ownElements={request.elements}
				onChangeOwnElements={(elements) => updateField("elements", elements)}
				kinds={kinds ?? []}
			/>

			<LegacyScriptNotice variant="pre" script={legacyPreScript} />
			<LegacyScriptNotice variant="post" script={legacyPostScript} />

			<ElementList
				elements={request.elements}
				onChange={(elements) => updateField("elements", elements)}
				kinds={addableKinds}
				emptyLabel="No elements yet. Add an extractor, assertion, timer or script from the menu below."
			/>
		</div>
	);
}

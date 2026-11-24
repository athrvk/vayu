/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The builder's Elements tab (#1512): one list of typed behaviours bound to `RequestState.elements`
 * through the shared `ElementList`, with what the collection chain adds above it
 * (`InheritedElementsNotice`) and the legacy glued-script notice for a design run recorded before
 * script parts existed. A `script.pre`/`script.post` row gets the "Names mentioned" chips above its
 * editor (#1553) via `renderAboveForm`: this host can answer `ScriptReferencesRow`'s props from
 * `useRequestBuilderContext`, which `ScriptElementForm` cannot depend on. An `assert.snapshot` row
 * gets "Use the current reply as the baseline" the same way (#3807), since the builder holds the
 * response.
 */

import { useElementKindsQuery, useRequestQuery } from "@/queries";
import { ElementList } from "@/components/shared/ElementList";
import { useOpenElementRows } from "@/components/shared/ElementList/useOpenElementRows";
import { ScriptReferencesRow } from "@/components/shared";
import { useRequestBuilderContext } from "../../../context";
import { useVariableSupport } from "../../../hooks/useVariableSupport";
import { startingElementConfigs } from "../../../utils/starting-element-configs";
import InheritedElementsNotice from "./InheritedElementsNotice";
import LegacyScriptNotice from "./LegacyScriptNotice";
import SnapshotBaselineAction from "./SnapshotBaselineAction";

export default function ElementsPanel() {
	const {
		request,
		response,
		updateField,
		inheritedElements,
		elementErrors,
		legacyPreScript,
		legacyPostScript,
		getAllVariables,
		getVariableOrigins,
		dataColumns,
	} = useRequestBuilderContext();
	const variables = useVariableSupport();
	const { data: kinds } = useElementKindsQuery();
	// The saved row, not the draft: the engine and the agent's tools do not know an unsaved rename.
	const { data: savedRequest } = useRequestQuery(request.id ?? null);
	const openRows = useOpenElementRows(request.id);
	// `script.setup` / `script.teardown` are collection-only (#1499): the engine refuses them on a
	// request, so Add never offers them, and `InheritedElementsNotice` leaves a collection's out of
	// "Runs before your own", since they run at the run's boundary (#3457).
	const addableKinds = (kinds ?? []).filter((kind) => !kind.collectionOnly);

	// A recorded baseline goes through the list's `onChange`, so it is the same edit as typing it.
	const recordBaseline = (id: string, baseline: unknown[]) =>
		updateField(
			"elements",
			request.elements.map((el) =>
				el.id === id ? { ...el, config: { ...el.config, baseline } } : el
			)
		);

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
				errors={elementErrors}
				variables={variables}
				startingConfigs={startingElementConfigs(request)}
				{...openRows}
				referenceOwner={
					savedRequest ? { type: "request", request: savedRequest } : undefined
				}
				renderAboveForm={(element) => {
					if (element.kind === "assert.snapshot") {
						return (
							<SnapshotBaselineAction
								element={element}
								replyBody={response?.body}
								onRecord={(baseline) => recordBaseline(element.id, baseline)}
							/>
						);
					}
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
						/>
					);
				}}
			/>
		</div>
	);
}

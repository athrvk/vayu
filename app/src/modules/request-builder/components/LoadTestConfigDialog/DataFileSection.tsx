/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Callout } from "@/components/shared";
import DataFilePicker from "@/modules/collections/DataFilePicker";
import type { LoadTestDataFile } from "./useLoadTestDataFile";

interface DataFileSectionProps {
	dataFile: LoadTestDataFile;
	disabled: boolean;
}

/**
 * A data file, for a run that parameterises its request (issue #993). Beside
 * the profile rather than under Recording & limits: rows change what each
 * submission *sends*, which is the same kind of decision the profile fields
 * are, while everything folded away below changes only what the run keeps.
 */
export function DataFileSection({ dataFile, disabled }: DataFileSectionProps) {
	return (
		<>
			{/* A file that could not be re-read is a warning, not a blocker -
			    the run is startable without one, and picking the file again
			    is the whole remedy. Same rule, same words, as the Run
			    collection dialog (issue #1039). */}
			{dataFile.prefillNote && (
				<Callout severity="warning" title="The remembered data file">
					{dataFile.prefillNote}
				</Callout>
			)}

			{dataFile.writerError && (
				<Callout severity="warning" title="Couldn't update the data contract">
					{dataFile.writerError.message}
					<span className="block">
						The run is unaffected. Pick the file again to retry.
					</span>
				</Callout>
			)}

			{/*
			    `loadTest` is set, so the picker describes what a row means here -
			    one per submission off a shared cursor that wraps - rather than the
			    design-mode "one row is one iteration" reading, which would be wrong
			    for every run this dialog starts.
			 */}
			<DataFilePicker
				selected={dataFile.file}
				onSelect={dataFile.select}
				onCastNumbersChange={dataFile.changeReading}
				// Only with a contract to clear: Remove on a collection that
				// declares nothing has nothing to write.
				onRemove={dataFile.clearContract}
				error={dataFile.error}
				onError={dataFile.setError}
				iterations={undefined}
				loadTest
				additionalWarnings={dataFile.warnings}
				disabled={disabled}
			/>
		</>
	);
}

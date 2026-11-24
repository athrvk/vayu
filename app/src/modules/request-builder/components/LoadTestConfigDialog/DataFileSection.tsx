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
 * A data file, for a run that parameterises its request (#993). Beside the profile, not under
 * Recording & limits: rows change what each submission sends, a profile-kind decision, while the
 * folded sections change only what the run keeps.
 */
export function DataFileSection({ dataFile, disabled }: DataFileSectionProps) {
	return (
		<>
			{/*
			 * An unreadable remembered file warns, never blocks: the run starts without it and
			 * picking it again is the remedy. Same rule and words as the Run collection dialog
			 * (#1039).
			 */}
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
			 * `loadTest` makes the picker describe a row as one per submission off a shared
			 * wrapping cursor, not design mode's "one row is one iteration", which is wrong for
			 * every run this dialog starts.
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

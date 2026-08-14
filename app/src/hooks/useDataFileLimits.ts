/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useDataFileLimits
 *
 * The two engine caps a collection run's data set has to fit inside:
 * `maxScenarioDataRows` and `maxScenarioDataBytes`.
 *
 * They live **engine-side**, and are read here rather than restated, for the
 * same reason `useMonitorSettings` reads its pair: the engine applies them at
 * `POST /runs` and a renderer copy could only drift. It would drift in the
 * direction that hurts - refusing a file the user had just raised the setting
 * to allow - and a user who raises a limit and still cannot pick the file has
 * no way to tell which side said no.
 *
 * Read-only: both are edited from the engine settings list. Until the config
 * query resolves the module seeds stand, which are the numbers the engine
 * itself seeds.
 */

import { useConfigQuery } from "@/queries";
import { DATA_FILE_MAX_BYTES, DATA_FILE_MAX_ROWS } from "@/constants/data-files";

export interface DataFileLimits {
	/** Most rows one run may carry, per `maxScenarioDataRows`. */
	maxRows: number;
	/** Most bytes one data set may carry, per `maxScenarioDataBytes`. */
	maxBytes: number;
}

export function useDataFileLimits(): DataFileLimits {
	const { data: config } = useConfigQuery();

	const entryNumber = (key: string, fallback: number): number => {
		// Entry values are strings. An absent key - config still loading, or an
		// engine older than these settings - leaves the seed rather than parsing
		// `undefined` to NaN.
		const raw = Number(config?.entries?.find((e) => e.key === key)?.value);
		return Number.isFinite(raw) && raw > 0 ? raw : fallback;
	};

	return {
		maxRows: entryNumber("maxScenarioDataRows", DATA_FILE_MAX_ROWS),
		maxBytes: entryNumber("maxScenarioDataBytes", DATA_FILE_MAX_BYTES),
	};
}

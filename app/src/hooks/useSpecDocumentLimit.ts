/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useSpecDocumentLimit
 *
 * The engine cap an imported OpenAPI document - and everything bundled into it
 * (issue #649) - has to fit inside: `maxSpecDocumentBytes`.
 *
 * Read from the engine rather than restated, the same rule `useDataFileLimits`
 * follows: `POST /specs` applies this cap, and a renderer copy could only drift
 * in the direction that hurts - refusing a spec the user had just raised the
 * setting to allow, with no way to tell which side said no.
 *
 * Read-only: the setting is edited from the engine settings list. Until the
 * config query resolves the module seed stands, which is the number the engine
 * itself seeds.
 */

import { useConfigQuery } from "@/queries";
import { SPEC_DOCUMENT_MAX_BYTES } from "@/constants/spec-documents";

export function useSpecDocumentLimit(): { maxBytes: number } {
	const { data: config } = useConfigQuery();
	// Entry values are strings. An absent key - config still loading, or an
	// engine older than this setting - leaves the seed rather than parsing
	// `undefined` to NaN.
	const raw = Number(config?.entries?.find((e) => e.key === "maxSpecDocumentBytes")?.value);
	return { maxBytes: Number.isFinite(raw) && raw > 0 ? raw : SPEC_DOCUMENT_MAX_BYTES };
}

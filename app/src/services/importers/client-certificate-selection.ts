/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which of an import's client-certificate candidates the user ticked (issue
 * #2363).
 *
 * A registered certificate is a host-wide registry row: every later request to
 * that host presents it, from any collection, and the row outlives the
 * collection that carried it. A Postman document can name a certificate path
 * on this machine, so a candidate is an offer from the document, not a choice
 * the user made. The selection is a list of indexes into
 * `ImportResult.clientCertificates`, so nothing can be sent that the preview
 * did not list.
 */

import type { ImportApplyClientCertificate } from "@/types";
import type { ImportResult } from "./types";

/** The candidates the preview lists, `[]` for every format that parses none. */
export function certificateCandidates(result: ImportResult): ImportApplyClientCertificate[] {
	return result.clientCertificates ?? [];
}

/**
 * The ticked candidates, in the order the preview listed them.
 *
 * An index outside the list is a caller bug, and it throws before anything is
 * sent: registering a different row than the one ticked is the failure this
 * selection exists to prevent.
 */
export function selectedCertificates(
	result: ImportResult,
	selected: readonly number[] = []
): ImportApplyClientCertificate[] {
	const candidates = certificateCandidates(result);
	const chosen = new Set(selected);
	for (const index of chosen) {
		if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
			throw new Error(
				`Client certificate selection names candidate ${index}, but the import lists ${candidates.length}`
			);
		}
	}
	return candidates.filter((_, index) => chosen.has(index));
}

/** How many candidates the apply will leave out; the preview tallies them as not imported. */
export function unselectedCertificateCount(
	result: ImportResult,
	selected: readonly number[] = []
): number {
	return certificateCandidates(result).length - selectedCertificates(result, selected).length;
}

/** The selection with @p index ticked or unticked, sorted and without repeats. */
export function withCertificateTicked(
	selected: readonly number[] = [],
	index: number,
	ticked: boolean
): number[] {
	const rest = selected.filter((i) => i !== index);
	return (ticked ? [...rest, index] : rest).sort((a, b) => a - b);
}

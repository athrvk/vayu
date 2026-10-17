/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Export Queries
 *
 * A collection written out in another tool's format. The OpenAPI export lives
 * with the rest of the spec reads in `specs.ts`, because it patches a bound
 * document; this file is for the formats that read no binding.
 */

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import type { RunReportExportRequest } from "@/types";
import { queryKeys } from "./keys";

/**
 * The collection, assembled into a Postman Collection v2.1 document.
 *
 * The same read `useSpecExportQuery` is, on the same terms: a POST that stores
 * nothing, keyed by the moment the dialog mounted so a reopened dialog asks
 * again while a toggle back within one opening is free, `retry: false` because
 * a missing collection is an answer, and the previous answer kept on screen
 * while the other one assembles (`placeholderData`, issue #1311) - the counts
 * the summary states do not depend on whether credentials are included, except
 * `secretsOmitted`, which the dialog hides while a re-read is in flight.
 */
export function usePostmanExportQuery(collectionId: string, includeSecrets: boolean) {
	const [opened] = useState(() => Date.now());
	return useQuery({
		queryKey: queryKeys.exports.postman(collectionId, includeSecrets, opened),
		queryFn: () => apiService.exportPostman({ collectionId, includeSecrets }),
		placeholderData: keepPreviousData,
		staleTime: Infinity,
		retry: false,
	});
}

/**
 * A finished load run as a file (issue #2127). A mutation, not a query: each
 * click asks again and nothing is cached, because the answer is downloaded the
 * moment it arrives and `generatedAt` makes every document a new one.
 */
export function useRunReportExport() {
	return useMutation({
		mutationFn: (payload: RunReportExportRequest) => apiService.exportRunReport(payload),
	});
}

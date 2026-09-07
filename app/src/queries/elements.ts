/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Element Kind Catalogue Query
 *
 * TanStack Query hook for the engine's element registry (issue #1512):
 * every extractor, assertion, timer, controller and script kind, with its
 * label, category and config JSON Schema. Drives the Add-element menu and
 * the generic schema-driven form.
 */

import { useQuery } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { QUERY_CACHE } from "@/config/cache";

export function useElementKindsQuery() {
	return useQuery({
		queryKey: queryKeys.elementKinds.all,
		queryFn: () => apiService.getElementKinds(),
		// The catalogue is static per engine version - not worth refetching on
		// every mount, same as script completions.
		staleTime: QUERY_CACHE.ELEMENT_KINDS_STALE_TIME_MS,
		gcTime: QUERY_CACHE.ELEMENT_KINDS_GC_TIME_MS,
		retry: QUERY_CACHE.ELEMENT_KINDS_RETRY,
	});
}

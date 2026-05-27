/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { assignIds } from "@/services/importers/assign-ids";
import { ImportOrchestrator, type ImportApi } from "@/services/importers/orchestrator";
import type { ImportOptions, ImportResult } from "@/services/importers/types";

/** Build an ImportApi backed by the real apiService. */
export function createImportApi(): ImportApi {
	return {
		createCollection: (d) => apiService.createCollection(d),
		createRequest: (d) => apiService.createRequest(d),
		createEnvironment: (d) => apiService.createEnvironment(d),
		deleteCollection: (id) => apiService.deleteCollection(id),
		deleteEnvironment: (id) => apiService.deleteEnvironment(id),
	};
}

export function useImportMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ result, opts }: { result: ImportResult; opts: ImportOptions }) => {
			const withIds = assignIds(result);
			await new ImportOrchestrator(createImportApi()).run(withIds, opts);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.requests.all });
		},
	});
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { assignTempIds } from "@/services/importers/assign-ids";
import { ImportOrchestrator, type ImportApi } from "@/services/importers/orchestrator";
import type { ImportOptions, ImportResult } from "@/services/importers/types";

/** Build an ImportApi backed by the real apiService. */
export function createImportApi(): ImportApi {
	return {
		applyImport: (payload) => apiService.applyImport(payload),
		getGlobals: () => apiService.getGlobals(),
		updateGlobals: (variables) => apiService.updateGlobals(variables),
	};
}

export function useImportMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		// `POST /import/apply` is create-only, atomic and carries no idempotency key -
		// the engine mints fresh ids per temp id on every call - so a second attempt
		// is a second full copy of the tree, not a resumed write. The shared
		// QueryClient defaults mutations to `retry: 1`, and TanStack re-invokes
		// `mutationFn` whole, so a *lost response* (commit succeeded, the 30s fetch
		// timeout fired) would duplicate everything and then report one clean import.
		// Retrying safely needs an engine-side idempotency key; until then, never.
		retry: false,
		mutationFn: async ({ result, opts }: { result: ImportResult; opts: ImportOptions }) => {
			const withTempIds = assignTempIds(result);
			await new ImportOrchestrator(createImportApi()).run(withTempIds, opts);
		},
		// Settled, not success: `run()` can throw *after* the tree is committed (the
		// id-map completeness check, or the globals write behind it), and with
		// `refetchOnWindowFocus: false` an uninvalidated sidebar hides a persisted
		// import until a manual reload. Invalidating after a failure that committed
		// nothing only costs a refetch.
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.requests.all });
			// A Postman globals export writes the globals singleton; without this the
			// imported variables sit on the engine unread until the next reload.
			queryClient.invalidateQueries({ queryKey: queryKeys.globals.all });
		},
	});
}

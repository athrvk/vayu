/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { invalidateAllRequestLists } from "./collections";
import { queryKeys } from "./keys";
import { assignTempIds } from "@/services/importers/assign-ids";
import { ImportOrchestrator, type ImportApi } from "@/services/importers/orchestrator";
import type { ImportApplyOptions, ImportResult } from "@/services/importers/types";
import { logError } from "@/errors/error-logger";
import type { SpecFileLocation } from "@/types";

/** Build an ImportApi backed by the real apiService. */
export function createImportApi(): ImportApi {
	return {
		applyImport: (payload) => apiService.applyImport(payload),
		getGlobals: () => apiService.getGlobals(),
		updateGlobals: (variables) => apiService.updateGlobals(variables),
	};
}

/**
 * Bind the picked file to every root the import bound a spec to (#2765).
 *
 * After the apply, not inside it: `POST /import/apply` refuses a file binding,
 * because an import describes a document from elsewhere, and the collection has
 * no id until the engine answers with the temp-id map. Called only for a
 * file-picked import - a URL-sourced spec records its origin portably, in
 * `spec_documents.source_url`.
 *
 * A write that fails is logged and the import still reports what it committed:
 * the tree landed, and failing the mutation would invite an import of it all
 * again. The Spec tab's check then says the binding has no file to re-read.
 */
async function bindSpecFiles(
	result: ImportResult,
	idMap: Record<string, string>,
	specFile: SpecFileLocation | undefined
): Promise<void> {
	if (!specFile?.path) return;
	const ids = result.collections.flatMap((root) => {
		const id = root.spec && root.tempId ? idMap[root.tempId] : undefined;
		return id ? [id] : [];
	});
	const writes = await Promise.allSettled(
		ids.map((id) => apiService.updateCollection({ id, specFile }))
	);
	for (const write of writes) {
		if (write.status === "fulfilled") continue;
		const reason: unknown = write.reason;
		logError(reason instanceof Error ? reason : new Error(String(reason)), "medium", {
			component: "renderer",
			action: "import-bind-spec-file",
		});
	}
}

/** What an applied import hands back: the real ids behind the temp ids it was sent with. */
export interface ImportApplied {
	/** The engine's whole temp-id -> real-id map. */
	idMap: Record<string, string>;
	/** Each root collection's temp id -> real id, in the order the file listed them. */
	rootIds: Record<string, string>;
	/** Each environment the apply created, temp id -> real id. Empty when environments were left out. */
	environmentIds: Record<string, string>;
}

/** The real id of every temp-id-stamped item in `items`, keyed by its temp id. */
function realIds(
	items: readonly { tempId?: string }[],
	idMap: Record<string, string>
): Record<string, string> {
	const ids: Record<string, string> = {};
	for (const { tempId } of items) {
		const id = tempId ? idMap[tempId] : undefined;
		if (tempId && id) ids[tempId] = id;
	}
	return ids;
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
		mutationFn: async ({
			result,
			opts,
			specFile,
		}: {
			result: ImportResult;
			opts: ImportApplyOptions;
			/**
			 * Where the imported document sits on this machine, when it was picked
			 * as a file. Ignored unless the tree actually carries a spec - every
			 * other format is a file too, and binding its path would claim a spec
			 * file that does not exist.
			 */
			specFile?: SpecFileLocation;
		}): Promise<ImportApplied> => {
			const withTempIds = assignTempIds(result);
			const idMap = await new ImportOrchestrator(createImportApi()).run(withTempIds, opts);
			await bindSpecFiles(withTempIds, idMap, specFile);
			return {
				idMap,
				rootIds: realIds(withTempIds.collections, idMap),
				environmentIds: realIds(withTempIds.environments, idMap),
			};
		},
		// Settled, not success: `run()` can throw *after* the tree is committed (the
		// id-map completeness check, or the globals write behind it), and with
		// `refetchOnWindowFocus: false` an uninvalidated sidebar hides a persisted
		// import until a manual reload. Invalidating after a failure that committed
		// nothing only costs a refetch.
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
			invalidateAllRequestLists(queryClient);
			// A Postman globals export writes the globals singleton; without this the
			// imported variables sit on the engine unread until the next reload.
			queryClient.invalidateQueries({ queryKey: queryKeys.globals.all });
			// A Postman `certificate` the engine resolved writes a registry row
			// through the same apply call (issue #1656); without this the
			// Settings card shows the old list until the next reload.
			queryClient.invalidateQueries({ queryKey: queryKeys.clientCertificates.all });
		},
	});
}

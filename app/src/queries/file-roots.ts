/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Allowed-folder queries (Settings > Files).
 *
 * The engine sends a request-body file nobody chose in the editor - an
 * imported path, a `{{var}}` path, a data-row path - only when it lies under
 * one of these folders. Three readers: the Settings card, the binary body
 * editor (whether its unresolved path is covered already) and the import
 * preview's "Allow folder" action.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";

/** Every allowed folder, ordered by path. Not polled: only this app writes it. */
export function useFileRootsQuery() {
	return useQuery({
		queryKey: queryKeys.fileRoots.all,
		queryFn: () => apiService.getFileRoots(),
	});
}

/**
 * Open the folder picker and allow what the user chooses (#2356): the main
 * process makes the write, so this takes where the picker opens, never a
 * folder. Resolves with the engine's answer, `cancelled` included.
 */
export function useAllowChosenFolderMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (options?: { defaultPath?: string; title?: string }) =>
			apiService.allowChosenFolder(options),
		onSuccess: (reply) => {
			// Refetched rather than appended: the engine stores the canonical
			// path, so the row it keeps can differ from the one the user picked.
			if (reply.outcome === "done") {
				void queryClient.invalidateQueries({ queryKey: queryKeys.fileRoots.all });
			}
		},
	});
}

export function useDeleteFileRootMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => apiService.deleteFileRoot(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.fileRoots.all });
		},
	});
}

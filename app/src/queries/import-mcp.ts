/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { mcpOAuthBearer } from "@/modules/collections/import-mcp";
import { invalidateAllRequestLists } from "./collections";
import { queryKeys } from "./keys";
import type { ImportMcpApplyRequest, ImportMcpApplyResponse, OAuth2Config } from "@/types";

export interface McpApplyVariables {
	payload: ImportMcpApplyRequest;
	/**
	 * The config an OAuth connect signed in with (#3983). Its token is fetched inside the mutation,
	 * so `isPending` holds the button across both calls and no token the connect sent is replayed.
	 */
	oauth?: OAuth2Config;
}

/**
 * Apply the rows of an MCP re-import diff the user ticked to the collection it compared (#3994). One
 * mutation for one engine call, which is one transaction, so a refusal (a 409 for a row the server's
 * listing no longer holds) wrote nothing and there is nothing to roll back or refetch.
 *
 * On success, not settled, and the same invalidation a spec sync makes (`useSyncSpecMutation`): the
 * collection list, and every request list as a family, since the creates land in the root's
 * Tools, Resources and Prompts folders and the deletes in any of them.
 *
 * `retry: false`: an added entry is a created request, so a second send of a lost reply is not a
 * resume. The shared client's default of one retry would turn it into a 409.
 */
export function useImportMcpApplyMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		retry: false,
		mutationFn: async ({
			payload,
			oauth,
		}: McpApplyVariables): Promise<ImportMcpApplyResponse> =>
			apiService.importMcpApply(
				oauth ? { ...payload, auth: await mcpOAuthBearer(oauth) } : payload
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			invalidateAllRequestLists(queryClient);
		},
	});
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateForMcpEvent } from "@/lib/mcp-invalidation";

/**
 * Keep the query cache in step with writes an agent makes over MCP.
 *
 * One listener for the whole app, registered at the root: the events name a
 * data family rather than a screen, so a second subscriber would only duplicate
 * every invalidation. Absent outside Electron (`electronAPI` is undefined in a
 * browser dev server), where there is no MCP server to hear from.
 */
export function useMcpDataInvalidation(): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		if (!window.electronAPI?.onMcpDataChanged) return;
		return window.electronAPI.onMcpDataChanged((event) => {
			invalidateForMcpEvent(queryClient, event);
		});
	}, [queryClient]);
}

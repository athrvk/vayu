/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./keys";

/**
 * Drop the cached `POST /compose` answers a write has made stale (#1877).
 *
 * The Code section's composition is `staleTime: Infinity`, so a write reaches
 * it only through an invalidation (`CodeSection.tsx`). This is the one place
 * that names the compose keys, shared by the renderer's own PUTs and the MCP
 * map (`lib/mcp-invalidation.ts`): two writers of one cache that each spelled
 * the key inline are how the renderer's half went missing.
 *
 * Name the request when the write changes only that request's composition. Omit
 * it for a write whose reach is engine-side knowledge - an environment, the
 * globals, a collection's inherited auth, headers and scripts - and the
 * invalidation takes every request, under every environment. `invalidateQueries`
 * refetches a mounted observer whatever its `staleTime`, so the narrow form is
 * what keeps a loop of request writes from re-composing an open snippet for a
 * request it never touched.
 */
export function invalidateCompositions(queryClient: QueryClient, requestId?: string): void {
	void queryClient.invalidateQueries({
		queryKey: requestId ? queryKeys.compose.allForRequest(requestId) : queryKeys.compose.all,
	});
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Saved example responses for a request (issue #481).
 *
 * Read-only for now, and that is the whole surface: examples arrive by import,
 * so there is nothing here to create or edit one with. The engine's per-example
 * write routes exist and are documented; a hook for them belongs in the change
 * that adds the editor, not ahead of it.
 */

import { useQuery } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";

/**
 * One request's examples, in stored order.
 *
 * Disabled without a request id so the Examples tab can call it
 * unconditionally: a request being composed has no id yet, and there is nothing
 * to fetch for one.
 */
export function useRequestExamplesQuery(requestId: string | null) {
	return useQuery({
		queryKey: queryKeys.requests.examples(requestId ?? ""),
		queryFn: () => apiService.listRequestExamples(requestId as string),
		enabled: !!requestId,
	});
}

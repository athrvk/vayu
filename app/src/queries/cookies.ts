/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cookie Jar Queries
 *
 * The engine keeps one cookie jar per environment for design-mode requests
 * (issue #301). These back the Settings card that shows what is held and
 * clears it.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";

/**
 * Every jar the engine holds.
 *
 * Not polled: the jar only changes when a request is sent or when this panel
 * clears it, and the panel invalidates itself after a clear. A user who sends
 * a request in another tab and comes back reads a stale count until the query
 * refetches on focus, which is the ordinary TanStack behaviour and cheap
 * enough to be right often.
 */
export function useCookiesQuery() {
	return useQuery({
		queryKey: queryKeys.cookies.all,
		queryFn: () => apiService.getCookies(),
	});
}

/**
 * Clear one jar, or every jar.
 *
 * `undefined` clears everything; `{ environmentId: null }` clears the jar used
 * when no environment is selected. They are different calls - see
 * `apiService.clearCookies`.
 */
export function useClearCookiesMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (scope?: { environmentId: string | null }) => apiService.clearCookies(scope),
		onSuccess: () => {
			// Refetch rather than patch: a clear that raced a request in flight
			// would leave a hand-patched cache claiming an empty jar the engine
			// has already refilled.
			void queryClient.invalidateQueries({ queryKey: queryKeys.cookies.all });
		},
	});
}

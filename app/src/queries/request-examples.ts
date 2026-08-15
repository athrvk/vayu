/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Saved example responses for a request (issues #481, #588).
 *
 * The list arrived first and was read-only: examples came from an importer, so
 * there was nothing here to write one with. #588 closed that loop - a response
 * on screen can be kept as an example, and an example can be removed again -
 * which is why the two mutations below exist and `PUT` still does not. Editing
 * a stored example is its own change; the panel is a viewer.
 *
 * Both writes settle by invalidating the one list key rather than splicing the
 * row in. The engine decides the id, the `order` an append lands on and the
 * stored shape of the row, so a hand-written cache entry would be this app's
 * guess at all three - and the list is one small request.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import type { CreateRequestExampleRequest } from "@/types";
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

/**
 * Keep a response as one of the request's examples (issue #588).
 *
 * The engine's refusals - a body over the per-example cap, the hundredth
 * example on one request - come back as the mutation's error and are shown by
 * the dialog that called it, not as a toast behind it.
 */
export function useCreateRequestExampleMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			requestId,
			example,
		}: {
			requestId: string;
			example: CreateRequestExampleRequest;
		}) => apiService.createRequestExample(requestId, example),
		onSuccess: (_created, { requestId }) => {
			void queryClient.invalidateQueries({
				queryKey: queryKeys.requests.examples(requestId),
			});
		},
	});
}

/**
 * Remove one saved example.
 *
 * An example you can create and never remove is the #553 shape at a smaller
 * scale, which is why this landed with the create rather than after it. It is
 * not scoped to app-saved rows: the engine's route is not, an imported example
 * is as much the user's to prune as a saved one, and telling the two apart
 * here would mean reading an `origin` no surface displays.
 */
export function useDeleteRequestExampleMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ requestId, exampleId }: { requestId: string; exampleId: string }) =>
			apiService.deleteRequestExample(requestId, exampleId),
		onSuccess: (_result, { requestId }) => {
			void queryClient.invalidateQueries({
				queryKey: queryKeys.requests.examples(requestId),
			});
		},
	});
}

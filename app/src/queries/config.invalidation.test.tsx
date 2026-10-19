/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A config write re-reads what a send adds on its own (issue #1438).
 *
 * `negotiateCompression`, `loadNegotiateCompression`, `sendExpectContinue`,
 * `correlationIdEnabled` and `correlationIdHeader` decide the Headers tab's
 * "Added by Vayu" rows, and the engine resolves the answer. The invalidation is
 * keyed by the `requestDefaults` root rather than by entry, so the case that
 * matters is a write of `sendExpectContinue` alone: the declared `Expect` row
 * must appear without the user reopening the tab (issue #2468).
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUpdateConfigMutation } from "./config";
import { queryKeys } from "./keys";

const updateConfig = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: { updateConfig: (...a: unknown[]) => updateConfig(...a) },
}));

describe("useUpdateConfigMutation", () => {
	it("invalidates both request-default scopes when sendExpectContinue is written", async () => {
		updateConfig.mockResolvedValue({ entries: [] });
		const queryClient = new QueryClient();
		queryClient.setQueryData(queryKeys.requestDefaults.scope("design"), { headers: [] });
		queryClient.setQueryData(queryKeys.requestDefaults.scope("load"), { headers: [] });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);

		const { result } = renderHook(() => useUpdateConfigMutation(), { wrapper });
		result.current.mutate({ key: "sendExpectContinue", value: "true" });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(updateConfig).toHaveBeenCalledWith({ key: "sendExpectContinue", value: "true" });
		for (const scope of ["design", "load"] as const) {
			expect(
				queryClient.getQueryState(queryKeys.requestDefaults.scope(scope))?.isInvalidated
			).toBe(true);
		}
	});
});

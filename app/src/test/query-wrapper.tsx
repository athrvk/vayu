/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A TanStack Query provider for tests that render a component which fetches.
 *
 * Every such test needs the same three lines - a fresh client, retries off so a
 * failure surfaces immediately instead of after three backoffs, and the
 * provider around the tree. Written once here rather than six times across the
 * files that render `RequestResponseView` and `SamplesTab`, both of which pull
 * their captured response bodies from `GET /runs/:id/samples`.
 *
 * A fresh client per call is deliberate: a shared one would carry one test's
 * cached page into the next.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

export function withQueryClient(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

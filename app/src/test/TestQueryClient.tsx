/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/**
 * `withQueryClient` (`query-wrapper.tsx`) as a component, for a tree that is
 * rendered more than once (`renderHook`'s `wrapper`, a `rerender`): the client
 * is made once per mount, so a rerender keeps the cache the first render filled.
 * Its own file because a module that exports a component beside a function is a
 * fast-refresh warning.
 */
export function TestQueryClient({ children }: { children: ReactNode }) {
	const [client] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
	);
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

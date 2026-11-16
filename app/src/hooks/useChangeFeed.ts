/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { changeFeedService } from "@/services/change-feed-service";
import { selectKnownEngineStatus, useEngineStore } from "@/stores";

/**
 * Keep the cache in step with every write to the engine's stored rows, whoever
 * made it (issue #3420). Mounted once in `App.tsx`, beside
 * `useMcpDataInvalidation`, which stays a second producer for the in-app MCP
 * server's writes: both invalidate through the same families, and an
 * invalidation twice over is a refetch, never a wrong answer.
 *
 * Open only while the engine is connected, as `selectKnownEngineStatus` reads
 * it: a crash the sidecar reported closes the feed before the poll confirms it
 * (#3506). The stream reconnects on its own across a dropped connection, but
 * an engine that is gone is the health poll's to notice, and a stream retrying
 * into it would only add to the noise.
 */
export function useChangeFeed(): void {
	const queryClient = useQueryClient();
	const connected = useEngineStore((s) => selectKnownEngineStatus(s) === "connected");

	useEffect(() => {
		if (!connected) return;
		changeFeedService.start(queryClient);
		return () => changeFeedService.stop();
	}, [connected, queryClient]);
}

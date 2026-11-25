/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bottom panel's Logs tab (#3635). `BottomPanel` mounts it in the tab's content box, a flex
 * child that fills the panel below the tab strip and clips (`min-h-0 overflow-hidden`), so the tab
 * scrolls its own list; it takes no props and reads stores and the preload bridge.
 *
 * Mounted only while the panel is open on this tab (a closed panel renders nothing, and Radix drops
 * an inactive tab's content), so mount and unmount are exactly when a tail (`logs:tail`) must start
 * and stop. The store's `start` and `stop` are bound to them here and nowhere else.
 *
 * The files are read by the main process, so outside Electron (the renderer under plain vite,
 * `app/CLAUDE.md`) there is nothing to read and the tab says so: no stub bridge, which would answer
 * as if it were one.
 */

import { useEffect } from "react";
import { EmptyState } from "@/components/shared/EmptyState";
import { LogList } from "./LogList";
import { LogsFooter } from "./LogsFooter";
import { LogsToolbar } from "./LogsToolbar";
import { useLogsStore } from "./logs-store";

function LogsView() {
	const start = useLogsStore((s) => s.start);
	const stop = useLogsStore((s) => s.stop);

	useEffect(() => {
		void start();
		return stop;
	}, [start, stop]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<LogsToolbar />
			<LogList />
			<LogsFooter />
		</div>
	);
}

export function LogsTab() {
	if (!window.electronAPI?.logs) {
		return <EmptyState variant="inline" title="Logs are available in the desktop app." />;
	}
	return <LogsView />;
}

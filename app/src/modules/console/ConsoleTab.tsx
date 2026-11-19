/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bottom panel's Console tab (#3634): everything this window sent, newest
 * last, from the session ring (`stores/console-store.ts`).
 *
 * `BottomPanel` mounts it in the tab's content box, a flex child that clips,
 * so the list scrolls itself. It takes no props. The ring outlives the tab:
 * closing the panel unmounts this and drops the filters, never the rows.
 */

import { useCallback, useState } from "react";
import { NO_CONSOLE_FILTER, type ConsoleFilter } from "./console-filter";
import { ConsoleList } from "./ConsoleList";
import { ConsoleToolbar } from "./ConsoleToolbar";

export function ConsoleTab() {
	const [filter, setFilter] = useState<ConsoleFilter>(NO_CONSOLE_FILTER);
	const changeFilter = useCallback(
		(change: Partial<ConsoleFilter>) => setFilter((current) => ({ ...current, ...change })),
		[]
	);
	const clearFilter = useCallback(() => setFilter(NO_CONSOLE_FILTER), []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ConsoleToolbar filter={filter} onFilterChange={changeFilter} />
			<ConsoleList filter={filter} onClearFilter={clearFilter} />
		</div>
	);
}

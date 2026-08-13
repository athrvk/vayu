/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The context a caller with no React of its own can still build.
 *
 * The native-menu bridge runs inside an Electron callback, not a render, and it
 * offers exactly one command rather than the roster - so it needs a context
 * without a tab label, a collection lookup or a dialog host. Everything a
 * command reads from a store is still true here, because stores are singletons;
 * what is missing is what only a mounted host knows, and the commands that need
 * that declare themselves unavailable.
 *
 * `useCommandContext` is the full version, for surfaces that render.
 */

import { useTabsStore } from "@/stores";
import type { CommandContext } from "./types";

export function baseCommandContext(): CommandContext {
	const { openTabs, activeTabId } = useTabsStore.getState();
	return {
		activeTab: openTabs.find((tab) => tab.id === activeTabId) ?? null,
		activeTabLabel: null,
		activeCollection: null,
	};
}

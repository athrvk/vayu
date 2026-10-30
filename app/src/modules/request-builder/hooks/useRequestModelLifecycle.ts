/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect } from "react";
import { useLoadedMonaco } from "@/lib/monaco-loader";
import { useTabsStore, type Tab } from "@/stores";
import { UNSAVED_AUTO_KEY } from "../context/auto-record-slot";
import { disposeRequestModels } from "../utils/editor-models";

/**
 * Bound the request editors' models (`utils/editor-models.ts`) to the open tabs.
 *
 * A model outlives the request switch on purpose - that is what keeps its undo
 * stack - so something has to end it. A tab closing does, and so does the
 * builder going away: `@monaco-editor/react` disposes only the model its editor
 * holds at unmount, and one left behind would greet the next mount with text
 * the request may have stopped having while the builder was gone.
 *
 * Subscribed to rather than selected, like the provider's other tab sweep: a
 * provider that re-rendered on every tab focus would pay for it on the request
 * the user is working in. The run ids stay for the same reason that sweep keeps
 * them - the History copy files under its run id - and the id-less key stays
 * because it names no tab.
 */
export function useRequestModelLifecycle(): void {
	const monaco = useLoadedMonaco();

	useEffect(() => {
		if (!monaco) return;
		const sweep = (tabs: readonly Tab[]) => {
			const open = new Set<string>([UNSAVED_AUTO_KEY]);
			for (const tab of tabs) {
				if (tab.entityId === null) continue;
				if (tab.type === "request" || tab.type === "run") open.add(tab.entityId);
			}
			disposeRequestModels(monaco, open);
		};
		sweep(useTabsStore.getState().openTabs);
		const unsubscribe = useTabsStore.subscribe((s) => sweep(s.openTabs));
		return () => {
			unsubscribe();
			disposeRequestModels(monaco, null);
		};
	}, [monaco]);
}

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
 * Bound the request editors' models (`utils/editor-models.ts`, #3136) to the
 * open tabs.
 *
 * A model outlives the request switch on purpose, which is what keeps its undo
 * stack, so a tab closing ends it, and so does the builder going away:
 * `@monaco-editor/react` disposes only the model its editor holds at unmount.
 *
 * Subscribed to rather than selected, like the provider's other tab sweep, so
 * a tab focus does not re-render the provider. The id-less key stays because it
 * names no tab. A History run copy has no request id either, so its models
 * file under that key and `HistoryDetail`'s `key={selectedRunId}` remount is
 * what ends them between runs; the `run` ids kept here are a guard for a copy
 * that ever files under its run id.
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

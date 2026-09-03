/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Monaco loader - the boundary that keeps the editor out of startup (#1146).
 *
 * `lib/monaco-setup.ts` was imported from `main.tsx` before React rendered, so
 * the monaco barrel and `graphql-language-service` were parsed on every cold
 * start whether or not the user ever opened an editor. This module imports it
 * dynamically instead, the first time a `CodeEditor` is about to mount.
 *
 * Two rules hold the ordering together, and both are load-bearing:
 *
 * 1. **`loader.config({ monaco })` must run before anything calls
 *    `loader.init()`.** `@monaco-editor/loader`'s `init()` injects
 *    `<script src="https://cdn.jsdelivr.net/…/vs/loader.js">` when no instance
 *    has been configured - a network fetch a desktop app has no business making
 *    and cannot complete offline. `ensureMonaco()` imports the setup module
 *    (which configures) before any editor renders, and is the only way monaco
 *    is brought in.
 * 2. **Registering a provider must not trigger the load.** The `pm.*`
 *    completions, `{{variable}}` completions and script type definitions
 *    register from `App`, which mounts long before any editor. They call
 *    `useLoadedMonaco()`, which subscribes and stays `null` until an editor has
 *    loaded monaco - `@monaco-editor/react`'s `useMonaco()` would call `init()`
 *    from that same mount and undo rule 1 and the split at once.
 */

import { useSyncExternalStore } from "react";
import type { MonacoApi } from "./monaco-api";

let loaded: MonacoApi | null = null;
let loading: Promise<MonacoApi> | null = null;
const subscribers = new Set<() => void>();

/**
 * Load and configure Monaco, once per session. Callers get the same promise;
 * a rejected one is cleared so a later editor mount can retry rather than
 * inheriting a failure from a transient chunk-load error.
 */
export function ensureMonaco(): Promise<MonacoApi> {
	loading ??= import("./monaco-setup").then(
		({ monaco }) => {
			loaded = monaco;
			for (const notify of [...subscribers]) notify();
			return monaco;
		},
		(error: unknown) => {
			loading = null;
			throw error;
		}
	);
	return loading;
}

function subscribe(onStoreChange: () => void): () => void {
	subscribers.add(onStoreChange);
	return () => {
		subscribers.delete(onStoreChange);
	};
}

function getSnapshot(): MonacoApi | null {
	return loaded;
}

/**
 * The configured Monaco instance once an editor has loaded it, `null` until
 * then. A passive subscriber: it never starts the load itself (rule 2 above),
 * so an effect guarded on it simply runs later, when the first editor arrives.
 */
export function useLoadedMonaco(): MonacoApi | null {
	return useSyncExternalStore(subscribe, getSnapshot);
}

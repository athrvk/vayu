/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A resolved preview that survives the component being unmounted. `resolveString` generates a
 * `{{$randomInt}}` / `{{$guid}}` / `{{$timestamp}}` value fresh on every call:
 * `lib/dynamic-variables.ts`'s contract, and right for resolution itself (two occurrences in one
 * body are two different ids), but wrong for a preview that claims to describe *one* field, which
 * would then change on its own while the field does not.
 *
 * **`useMemo` is not enough, because the remount is the common case.** Radix unmounts an inactive
 * `TabsContent`, and only Body and Elements are force-mounted (`RequestTabs/index.tsx`), so Params
 * → Headers → Params tears `ParamsPanel` down and builds a new one, and a fresh mount has no
 * previous render to memoize against; likewise every panel behind a collapsed section, a closed
 * drawer or a tab the user left. The cache has to outlive the component, which means module scope:
 * a `useRef` whose `.current` is written from render trips this repo's `react-hooks/refs` gate,
 * committing the write from a `useEffect` trips `react-hooks/set-state-in-effect` right back, and
 * neither survives the unmount anyway.
 *
 * **Keyed by entity id, never by the template text.** Two *different* fields holding byte-identical
 * `{{$guid}}` text must be free to resolve differently (the resolver conformance fixture asserts
 * exactly that), so a cache keyed on the text would collapse them and break the primitive it wraps.
 * Each call site keeps a cache of its own (one per *field*, not one per app) keyed by the
 * request/tab id: one entry per logical field, and one field's value is never handed to another.
 *
 * **Invalidated by the text or by the resolver's identity.** `resolveString` is a `useCallback`
 * over `variableMap` and `rowCells`, so its identity changes on a real variable edit, an
 * environment switch or a bound-row change, exactly the events that should produce a new value, and
 * on nothing else.
 *
 * That second half is also the cache's boundary: **the resolver has to outlive the component.** A
 * panel whose `resolveString` comes from a provider above it (`ParamsPanel`, from the request
 * builder's context) keeps the same function across its own unmount, so the entry is still valid on
 * the way back. A hook that calls `useVariableResolver` *itself* gets a new function on every
 * mount, so a remount misses regardless; there a plain `useMemo` is the honest tool, and a shared
 * module cache is worse when two consumers of one hook render side by side (see
 * `context-bar/relevance.ts`), each one's resolver invalidating the other's entry every render.
 *
 * A miss resolves inline for that same render, so the value on screen is never a frame late, and
 * fills the cache for the next one. Bounded by the number of distinct entities visited this
 * session, the magnitude several other caches in the app keep.
 */

interface CacheEntry<T> {
	input: string;
	/** The `resolveString` that produced `resolved`, compared by identity. */
	resolve: (input: string) => T;
	resolved: T;
}

/**
 * Resolve `input` for the field identified by `key`, reusing the last value
 * unless the text or the resolver changed.
 */
export type StableResolve<T = string> = (
	key: string,
	input: string,
	resolve: (input: string) => T
) => T;

/** One cache, for one field. Call it once at module scope, never in render. */
export function createStableResolve<T = string>(): StableResolve<T> {
	const cache = new Map<string, CacheEntry<T>>();
	return (key, input, resolve) => {
		const cached = cache.get(key);
		if (cached && cached.input === input && cached.resolve === resolve) return cached.resolved;
		const resolved = resolve(input);
		cache.set(key, { input, resolve, resolved });
		return resolved;
	};
}

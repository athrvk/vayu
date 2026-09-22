/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A resolved preview that survives the component being unmounted.
 *
 * `resolveString` generates a `{{$randomInt}}` / `{{$guid}}` / `{{$timestamp}}`
 * value fresh on every call - that is `lib/dynamic-variables.ts`'s contract, and
 * it is right for resolution itself: two occurrences in one body are two
 * different ids. It is wrong for a preview that claims to describe *one* field,
 * which then changes on its own while the field it describes does not.
 *
 * **`useMemo` is not enough, because the remount is the common case.** Radix
 * unmounts an inactive `TabsContent`, and only Body and Elements are
 * force-mounted (`RequestTabs/index.tsx`) - so Params → Headers → Params tears
 * `ParamsPanel` down and builds a new one, and a fresh mount has no previous
 * render to memoize against. The same goes for every panel behind a collapsed
 * section, a closed drawer or a tab the user navigated away from. A cache has to
 * outlive the component to answer this, which means module scope:
 *
 * - a `useRef` whose `.current` is written from render trips this repo's
 *   `react-hooks/refs` gate, and committing the write from a `useEffect` trips
 *   `react-hooks/set-state-in-effect` right back;
 * - and neither survives the unmount anyway, which is the whole problem.
 *
 * **Keyed by entity id, never by the template text.** Two *different* fields
 * holding byte-identical `{{$guid}}` text must be free to resolve differently -
 * the resolver conformance fixture asserts exactly that - so a cache keyed on
 * the text would collapse them into one value and break the primitive it is
 * wrapping. Each call site therefore keeps a cache of its own (one per *field*,
 * not one per app) and keys it by the request/tab id: one entry per logical
 * field, and one field's value can never be handed to another.
 *
 * **Invalidated by the text or by the resolver's identity.** `resolveString` is
 * a `useCallback` over `variableMap` and `rowCells`, so its identity changes on
 * a real variable edit, an environment switch or a bound-row change - exactly
 * the events that should produce a new value - and on nothing else.
 *
 * That second half is also the cache's boundary, and it decides where this is
 * worth using: **the resolver has to outlive the component.** A panel whose
 * `resolveString` comes from a provider above it (`ParamsPanel`, from the
 * request builder's context) keeps the same function across its own unmount, so
 * the entry is still valid on the way back in. A hook that calls
 * `useVariableResolver` *itself* gets a new function on every mount, so a
 * remount misses the cache no matter what - there a plain `useMemo` is the
 * honest tool, and a shared module cache is actively worse when two consumers
 * of one hook render side by side (see `context-bar/relevance.ts`), because
 * each one's resolver invalidates the other's entry every render.
 *
 * A miss resolves inline for that same render, so the value on screen is never
 * a frame late; the same call fills the cache for whatever render comes next.
 * Bounded by the number of distinct entities visited this session, the same
 * magnitude several other caches in the app keep.
 */

interface CacheEntry {
	input: string;
	/** The `resolveString` that produced `resolved`, compared by identity. */
	resolve: (input: string) => string;
	resolved: string;
}

/**
 * Resolve `input` for the field identified by `key`, reusing the last value
 * unless the text or the resolver changed.
 */
export type StableResolve = (
	key: string,
	input: string,
	resolve: (input: string) => string
) => string;

/** One cache, for one field. Call it once at module scope, never in render. */
export function createStableResolve(): StableResolve {
	const cache = new Map<string, CacheEntry>();
	return (key, input, resolve) => {
		const cached = cache.get(key);
		if (cached && cached.input === input && cached.resolve === resolve) return cached.resolved;
		const resolved = resolve(input);
		cache.set(key, { input, resolve, resolved });
		return resolved;
	};
}

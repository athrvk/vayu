/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request builder's debounced auto-save must not carry `name`.
 *
 * The builder never edits the name - it is renamed from the collection sidebar -
 * so `request.name` is only a snapshot taken when the tab opened, and the reset
 * effect keeps the builder state keyed by request id. A rename does not change
 * the id, so that snapshot goes stale. When the save payload still included
 * `name`, the auto-save fired a few seconds after any edit and overwrote a fresh
 * sidebar rename with the old name. The engine does a partial update on an
 * existing id, so omitting `name` leaves the current (renamed) value untouched.
 *
 * A scan, not a render, for the reason `redirect-policy-plumbing.test.ts` gives:
 * the save lives inside a `useCallback` wired to TanStack Query, several zustand
 * stores and the engine service, and standing that up would test the mocks. The
 * name must still be *loaded* into the editor (it seeds `initialRequest`), so
 * this locks both directions: read yes, write no.
 */

import { describe, it, expect } from "vitest";

const sources = import.meta.glob("/src/modules/request-builder/index.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

const source = (Object.values(sources)[0] as string | undefined) ?? "";

/** The object literal passed to `updateRequestMutation.mutateAsync(...)`. */
function savePayload(src: string): string | null {
	const start = src.indexOf("updateRequestMutation.mutateAsync(");
	if (start === -1) return null;
	const open = src.indexOf("{", start);
	if (open === -1) return null;
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
	}
	return null;
}

describe("the request builder save omits name", () => {
	it("found the request builder source (guards the scan itself)", () => {
		// vitest stubs some imports to "", and a moved file would make every
		// assertion below pass vacuously.
		expect(source.length).toBeGreaterThan(1000);
		expect(source).toContain("updateRequestMutation.mutateAsync");
	});

	it("still loads the name into the editor state", () => {
		// initialRequest seeds the builder from the fetched request; the name has
		// to round-trip in, it just must not round-trip back out on save.
		const loads = source.match(/\bname:\s*fetchedRequest\.name\b/g) ?? [];
		expect(loads).toHaveLength(1);
	});

	it("does not send name in the save payload", () => {
		const payload = savePayload(source);
		expect(payload).not.toBeNull();
		// Right block, non-empty: these builder-owned fields are still saved.
		expect(payload).toContain("description: request.description");
		expect(payload).toContain("url: request.url");
		// The regression: a `name:` key anywhere in the payload reintroduces the
		// clobber. Reverting the fix puts `name: request.name` back and trips this.
		expect(payload).not.toMatch(/\bname\s*:/);
	});
});

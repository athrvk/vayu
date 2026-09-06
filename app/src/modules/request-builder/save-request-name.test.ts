/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request builder's auto-save carries `name` - trimmed, and never blank.
 *
 * It used to carry none at all, and the reason was staleness rather than
 * ownership. The builder held a snapshot of the name taken when the tab opened;
 * the reset is keyed by request id and a rename does not change the id, so an
 * edit made minutes after a sidebar rename fired a debounced save carrying the
 * pre-rename name and overwrote it. Omitting the key sidestepped that, at the
 * price of a builder that could never rename anything - which is what the Info
 * tab's name field now has to do.
 *
 * The fix is upstream, in the provider: it adopts a name that changes underneath
 * it (`initialRequest.name`, i.e. the request query's copy), so what is sent
 * here is never a snapshot. That adoption is the load-bearing half and is
 * asserted in `RequestBuilderProvider.name-sync.test.tsx`; this file guards the
 * write end - `name` present, trimmed, and dropped entirely when blank so a
 * partial update leaves the stored one alone.
 *
 * A scan, not a render, for the reason `redirect-policy-plumbing.test.ts` gives:
 * the save lives inside a `useCallback` wired to TanStack Query, several zustand
 * stores and the engine service, and standing that up would test the mocks.
 *
 * Updated for issue #1436: the payload is no longer built inline at the
 * `mutateAsync` call site - it comes from `buildUpdatePayload`, a named
 * function that includes each field only when the caller says it was touched,
 * so a save carries just what the user changed. The scan below reads that
 * function's body instead of the call site's object literal.
 */

import { describe, it, expect } from "vitest";

const sources = import.meta.glob("/src/modules/request-builder/index.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

const source = (Object.values(sources)[0] as string | undefined) ?? "";

/** The body of `buildUpdatePayload`, where the save payload is actually built. */
function updatePayloadBody(src: string): string | null {
	const start = src.indexOf("function buildUpdatePayload(");
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

describe("the request builder save and the request name", () => {
	it("found the request builder source (guards the scan itself)", () => {
		// vitest stubs some imports to "", and a moved file would make every
		// assertion below pass vacuously.
		expect(source.length).toBeGreaterThan(1000);
		expect(source).toContain("updateRequestMutation.mutateAsync");
	});

	it("still loads the name into the editor state", () => {
		// initialRequest seeds the builder from the fetched request. The name has
		// to round-trip in as well as out - it is what the provider's adoption
		// compares against, and what the breadcrumb and the Info tab render.
		const loads = source.match(/\bname:\s*fetchedRequest\.name\b/g) ?? [];
		expect(loads).toHaveLength(1);
	});

	it("trims the name before it is sent", () => {
		// Untrimmed, "  Users" and "Users" are different names in every list that
		// shows them, and the value diverges from what the field shows the moment
		// the query cache comes back.
		expect(source).toMatch(/const name = request\.name\.trim\(\)/);
	});

	it("sends the trimmed name, and omits the key when it is blank", () => {
		const body = updatePayloadBody(source);
		expect(body).not.toBeNull();
		// Right block, non-empty: these builder-owned fields are still saved
		// when the caller says they were touched (issue #1436).
		expect(body).toContain("payload.description = request.description");
		expect(body).toContain("payload.url = request.url");
		/*
		 * The `if (name)` guard is the whole rule. `payload.name = name`
		 * unconditionally would write an empty string on a cleared field and
		 * leave the request nameless in the sidebar, the tab strip and the
		 * breadcrumb; the engine does a partial update, so an absent key keeps
		 * the stored name instead.
		 */
		expect(body).toMatch(/if \(name\) payload\.name = name;/);
		expect(body).not.toMatch(/\bpayload\.name\s*=\s*request\.name\b/);
	});
});

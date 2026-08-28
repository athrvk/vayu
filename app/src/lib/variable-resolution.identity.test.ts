/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `$vu` / `$iteration` reservation (issue #994), as a standalone mutation
 * check: the shared conformance fixture already covers this (see
 * `variable-resolution.conformance.test.ts`), but that guard goes red only
 * together with the whole fixture-driven suite. This file exercises
 * `resolveTemplate` directly, the same way `data-contract.test.ts` documents
 * the `data.*` boundary, so a revert of the reservation in
 * `variable-resolution.ts` fails here without touching the fixture at all.
 */

import { describe, expect, test } from "vitest";
import { resolveTemplate } from "./variable-resolution";

describe("$vu / $iteration stay reserved through resolveTemplate", () => {
	test("keep their braces with no lookup answering at all", () => {
		expect(resolveTemplate("{{$vu}}/{{$iteration}}", () => undefined)).toBe(
			"{{$vu}}/{{$iteration}}"
		);
	});

	test("a scope variable of the same name never answers for them", () => {
		// The regression this guards: reverting the reservation in
		// `resolveTemplate` (moving the `isIterationVariableName` check after the
		// `lookup` call, or deleting it) makes this substitute "shadowed" - the
		// engine never lets that happen, so the preview must not either.
		const lookup = (name: string) => (name === "$vu" ? "shadowed" : undefined);
		expect(resolveTemplate("{{$vu}}", lookup)).toBe("{{$vu}}");
	});

	test("a name that only looks like the identity is an ordinary unknown name", () => {
		expect(resolveTemplate("{{$vus}}", () => undefined)).toBe("{{$vus}}");
	});
});

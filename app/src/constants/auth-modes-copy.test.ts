/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * No surface may tell a user that an auth mode the engine does not execute is
 * still sent (#2474). digest/aws/ntlm/hawk/oauth1/edgegrid/jwt arrive from
 * imports and go out with no auth; the first copy of this wording said the
 * opposite in four places, and each place was written separately.
 *
 * The rendered wording is asserted in the component tests. This scan is the
 * net for a surface that is not rendered by one: it reads the sources that
 * speak about these modes and fails on the phrases that implied they run.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { stripComments } from "@/lib/strip-comments.testkit";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SURFACES = [
	"modules/request-builder/components/RequestTabs/panels/AuthPanel.tsx",
	"components/layout/context-bar/AuthContextSection.tsx",
	"modules/request-builder/components/RequestTabs/panels/AuthInheritBanner.tsx",
	"modules/collections/CollectionDetail/AuthTab.tsx",
	"components/shared/AuthFields/AuthFields.tsx",
	"services/codegen/prepare.ts",
];

const FALSE_CLAIMS = [
	"still sent with this request",
	"computed at send time",
	"happens on the wire",
	"still what descendant requests inherit",
	"still what runs",
];

describe("copy about auth modes the engine does not execute", () => {
	for (const surface of SURFACES) {
		it(`${surface} does not say such a mode is still sent`, () => {
			const code = stripComments(readFileSync(resolve(src, surface), "utf8"));
			// A moved or emptied file would pass the phrase checks forever.
			expect(code.trim().length).toBeGreaterThan(0);
			for (const phrase of FALSE_CLAIMS) {
				expect(code, phrase).not.toContain(phrase);
			}
		});
	}
});

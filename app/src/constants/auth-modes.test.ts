/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The mode registry (issue #105).
 *
 * Four places named the auth modes independently and had drifted - the two
 * pickers said "OAuth 2.0" and "AWS Signature" where `AuthInheritBanner`
 * rendered raw `OAUTH2` and `AWS`. These tests pin the properties that keep one
 * list from silently becoming two again: every mode the domain can hold is
 * named here, and the editable subset is exactly the modes the engine can
 * resolve.
 */

import { describe, it, expect } from "vitest";
import type { AuthMode } from "@/types";
import {
	AUTH_MODE_LABELS,
	EDITABLE_AUTH_MODES,
	isEditableAuthMode,
	isUneditableAuthMode,
	uneditableAuthLabel,
} from "./auth-modes";

/**
 * Every member of the domain `AuthMode` union. Written out rather than derived,
 * so adding a mode to the union without naming it is a compile error here (the
 * annotation) and a failure below (the label sweep).
 */
const ALL_MODES: AuthMode[] = [
	"none",
	"inherit",
	"bearer",
	"basic",
	"apikey",
	"oauth2",
	"digest",
	"aws",
	"ntlm",
];

describe("auth mode registry", () => {
	it("names every mode a request or collection can store", () => {
		for (const mode of ALL_MODES) {
			expect(AUTH_MODE_LABELS[mode], mode).toBeTruthy();
		}
		expect(Object.keys(AUTH_MODE_LABELS).sort()).toEqual([...ALL_MODES].sort());
	});

	it("offers exactly the modes the engine can resolve", () => {
		expect([...EDITABLE_AUTH_MODES]).toEqual(["none", "bearer", "basic", "apikey", "oauth2"]);
	});

	it("never offers a mode the engine cannot resolve", () => {
		// Offering digest/aws/ntlm would let someone configure something that
		// silently does nothing - the opposite of the bug #61 fixed.
		for (const mode of ["digest", "aws", "ntlm"] as const) {
			expect(isUneditableAuthMode(mode)).toBe(true);
			expect(isEditableAuthMode(mode)).toBe(false);
			expect(EDITABLE_AUTH_MODES as readonly string[]).not.toContain(mode);
		}
	});

	it("keeps inherit out of the shared list - it is request-only", () => {
		// A collection is always an auth source. The request panel prepends it.
		expect(EDITABLE_AUTH_MODES as readonly string[]).not.toContain("inherit");
		expect(AUTH_MODE_LABELS.inherit).toBe("Inherit from Collection");
	});

	it("names an uneditable mode and refuses to name an editable one", () => {
		expect(uneditableAuthLabel("aws")).toBe("AWS Signature");
		expect(uneditableAuthLabel("bearer")).toBeNull();
	});

	it("spells the modes the way the pickers do", () => {
		// The banner used to uppercase the raw discriminant. These are the strings
		// the two auth editors show, so they are the ones every surface must use.
		expect(AUTH_MODE_LABELS.oauth2).toBe("OAuth 2.0");
		expect(AUTH_MODE_LABELS.apikey).toBe("API Key");
		expect(AUTH_MODE_LABELS.aws).toBe("AWS Signature");
	});
});

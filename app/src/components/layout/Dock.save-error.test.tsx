/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A save failure should say why.
 *
 * `save-store` records an `errorMessage` on every failure - "database is
 * locked", "disk full" - and nothing read it, so the status strip showed a bare
 * "Save failed" for every cause. This is the fourth instance of the same shape
 * on this branch: state written by one layer, read by none.
 *
 * The reader is what needs guarding. A store test would pass whether or not
 * anything renders the field, which is exactly how it stayed unread.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { useSaveStore } from "@/stores";

const dock = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Dock.tsx"), "utf8");
const code = dock.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

beforeEach(() => useSaveStore.setState({ status: "idle", errorMessage: null }));

describe("save failure reporting", () => {
	it("still has a writer for the message", () => {
		// If nothing writes it, the reader below is dead weight and should go too
		// rather than sit there looking like coverage.
		useSaveStore.getState().failSave("database is locked");
		expect(useSaveStore.getState().errorMessage).toBe("database is locked");
		expect(useSaveStore.getState().status).toBe("error");
	});

	it("reads the message in the Dock, not just the status", () => {
		expect(code).toMatch(/errorMessage:\s*saveError/);
		expect(code).toContain("saveError");
	});

	it("renders the reason alongside the failure", () => {
		expect(code).toMatch(/Save failed - \$\{saveError\}/);
	});

	it("falls back to the bare text when there is no message", () => {
		// `failSave()` is called with no argument in places, so the fallback is a
		// real path rather than defensive padding.
		expect(code).toMatch(/:\s*"Save failed"/);
	});

	it("keeps the strip from being widened by an engine message of any length", () => {
		expect(code).toMatch(/truncate/);
		expect(code).toMatch(/title=\{saveError/);
	});
});

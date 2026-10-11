/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SPEC_FILE_EXTENSIONS } from "./spec-file";

interface FileAssociation {
	ext: string | string[];
	role?: string;
	rank?: string;
}

const config = JSON.parse(
	readFileSync(path.resolve(__dirname, "../electron-builder.json"), "utf8")
) as {
	fileAssociations?: FileAssociation[];
	mac?: { fileAssociations?: FileAssociation[] };
	win?: { fileAssociations?: FileAssociation[] };
	linux?: { mimeTypes?: string[]; fileAssociations?: FileAssociation[] };
};

const macAssociations = config.mac?.fileAssociations ?? [];

/** electron-builder takes `ext` bare, without the dot `SPEC_FILE_EXTENSIONS` carries. */
function declaredExtensions(): string[] {
	return macAssociations.flatMap((association) => [association.ext].flat());
}

describe("electron-builder file associations (#1919)", () => {
	it("scans a non-empty extension list, so the cases below cannot pass on nothing", () => {
		expect(SPEC_FILE_EXTENSIONS.length).toBeGreaterThan(0);
		expect(macAssociations.length).toBeGreaterThan(0);
	});

	it("declares every extension the import pipeline accepts", () => {
		const declared = declaredExtensions();

		for (const extension of SPEC_FILE_EXTENSIONS) {
			expect(declared, extension).toContain(extension.replace(/^\./, ""));
		}
	});

	it("registers Vayu as a Viewer and an Alternate, never the default for .json", () => {
		// `Editor` is electron-builder's default role and `Default` its default
		// rank; either would offer to make Vayu the double-click handler for every
		// JSON file on the machine.
		for (const association of macAssociations) {
			expect(association.role, JSON.stringify(association.ext)).toBe("Viewer");
			expect(association.rank, JSON.stringify(association.ext)).toBe("Alternate");
		}
	});

	it("leaves Windows to the manual Open with, which the argv door already serves", () => {
		// NSIS's APP_ASSOCIATE writes the extension key's default value, replacing
		// whichever program the user's JSON files opened with, and uninstall
		// does not put it back. A top-level `fileAssociations` reaches NSIS too.
		expect(config.fileAssociations).toBeUndefined();
		expect(config.win?.fileAssociations).toBeUndefined();
	});

	it("declares no Linux MIME types while the desktop entry's Exec ends in %U", () => {
		// electron-builder appends %U, so a file manager may pass file:// URLs,
		// which the open-intent door does not decode.
		expect(config.linux?.mimeTypes).toBeUndefined();
	});
});

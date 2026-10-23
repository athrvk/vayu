/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `release.yml` attests every release asset except the `.sha256` sidecars
 * (#2372). The updater's installer gate (`update-attestation.ts`) fails closed
 * on an installer with no attestation, and the `latest*.yml` feeds are what
 * name that installer: an exclusion that crept back in would leave them
 * unattested while the docs say otherwise. The workflow lives outside `app/`,
 * so it is registered in `ROOT_READING_GUARDS` and an edit to it runs this file.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOT_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";

const [workflowPath] = ROOT_READING_GUARDS.releaseAttestationScope.paths.map(fromRepoRoot);
const workflow = readFileSync(workflowPath, "utf8");

/** The globs under the attest step's `subject-path: |`, one per line. */
function subjectPaths(text: string): string[] {
	const lines = text.split("\n");
	const key = lines.findIndex((line) => /^\s*subject-path: \|$/.test(line));
	if (key === -1) return [];
	const keyIndent = lines[key].length - lines[key].trimStart().length;
	const globs: string[] = [];
	for (const line of lines.slice(key + 1)) {
		const indent = line.length - line.trimStart().length;
		if (line.trim() === "" || indent <= keyIndent) break;
		globs.push(line.trim());
	}
	return globs;
}

describe("release.yml attestation scope", () => {
	it("was read from disk", () => {
		expect(workflow.length).toBeGreaterThan(1000);
	});

	it("still attests with actions/attest-build-provenance", () => {
		expect(workflow).toContain("actions/attest-build-provenance@");
	});

	it("attests every asset and excludes only the .sha256 sidecars", () => {
		expect(subjectPaths(workflow)).toEqual(["artifacts/*", "!artifacts/*.sha256"]);
	});

	it("does not exclude the electron-updater feeds", () => {
		expect(workflow).not.toContain("!artifacts/*.yml");
	});
});

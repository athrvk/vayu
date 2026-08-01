/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer state docs name real hooks and real constants. They have to stay
 * real.
 *
 * `docs/app/state-management.md` had drifted into documenting three hooks that
 * do not exist (`useSSE`, `useEngine().startLoadTest`, `useStopRunMutation`), a
 * fourth that never did (`useCollectionQuery`), and a `HISTORICAL_METRICS_CAP`
 * asserted four times across two files - all of it read as authoritative,
 * because that is what these docs are for.
 *
 * So this checks the *identifiers*: every `useXxx` and every SCREAMING_CASE name
 * the prose puts in backticks must exist in the app source. Prose is not
 * checked and cannot be - a hook that exists says nothing about the sentence
 * around it.
 *
 * One escape hatch, itself checked: `OWNED_ELSEWHERE` names identifiers that
 * live outside `app/src` - the engine's half of a shared default - and asserts
 * the named file still declares them.
 *
 * Comments count as source. A name a doc mentions *because* it was deleted
 * (`AUTO_SAVE_DELAY_MS`) survives here only as long as the comment explaining
 * its removal survives, which is the right coupling: delete the explanation and
 * the doc's reference to it has to go too.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** The docs whose identifiers this guards. */
const DOCS = [
	"docs/app/state-management.md",
	"docs/app/architecture.md",
	"docs/app/api-integration.md",
];

/**
 * Identifiers the docs name that are declared outside `app/src`, with the file
 * that owns each. Kept short on purpose: a doc under `docs/app/` reaching into
 * the engine is a claim about a shared contract, not a convenience.
 */
const OWNED_ELSEWHERE: Record<string, string> = {
	// The renderer's DEFAULT_MAX_RETAINED_TICKS and this are one number in two
	// places, and state-management.md says so - so it has to still be there.
	DEFAULT_MAX_LIVE_TICKS: "engine/include/vayu/core/constants.hpp",
	// api-integration.md explains which libcurl constant `httpVersion: "http2"`
	// becomes; the mapping is the engine's.
	CURL_HTTP_VERSION_2TLS: "engine/include/vayu/http/curl_version_map.hpp",
};

/**
 * Identifiers a doc names *because they are gone*. The sentence carries why,
 * which is worth keeping, so the name is excused here - and the absence is
 * asserted, so re-introducing one fails until it leaves this list.
 */
const REMOVED_ON_PURPOSE = [
	// api-integration.md: the old SSE constant, replaced by /runs/:id/live.
	"STATS_STREAM",
];

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			sourceFiles(full, out);
		} else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

/** Every identifier declared or referenced in non-test renderer + electron source. */
function sourceIdentifiers(): Set<string> {
	const ids = new Set<string>();
	for (const file of [...sourceFiles(here), ...sourceFiles(join(repoRoot, "app", "electron"))]) {
		for (const m of readFileSync(file, "utf8").matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
			ids.add(m[0]);
		}
	}
	return ids;
}

/**
 * Identifiers quoted in a doc's prose.
 *
 * Fenced code blocks are blanked first: they carry illustrative and pseudo-code
 * names, and the claims that matter are the ones the prose makes. Only inline
 * backtick spans count. Blanked rather than removed so the reported line
 * numbers still point at the doc - a failure naming the wrong line sends the
 * next reader hunting.
 */
function quotedIdentifiers(markdown: string): Map<string, number> {
	const found = new Map<string, number>();
	const lines = markdown
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ""))
		.split(/\r?\n/);
	lines.forEach((line, i) => {
		for (const span of line.matchAll(/`([^`]+)`/g)) {
			for (const m of span[1].matchAll(/\buse[A-Z][A-Za-z0-9]*/g)) {
				if (!found.has(m[0])) found.set(m[0], i + 1);
			}
			for (const m of span[1].matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
				if (!found.has(m[0])) found.set(m[0], i + 1);
			}
		}
	});
	return found;
}

describe("renderer state docs name real identifiers", () => {
	const ids = sourceIdentifiers();
	const docs = DOCS.map((path) => ({
		path,
		quoted: quotedIdentifiers(readFileSync(join(repoRoot, path), "utf8")),
	}));

	it("scanned a non-empty source tree and non-empty docs", () => {
		expect(ids.size).toBeGreaterThan(2000);
		expect(ids.has("useSaveManager")).toBe(true);
		for (const { path, quoted } of docs) {
			expect(quoted.size, `${path} yielded no quoted identifiers`).toBeGreaterThan(5);
		}
	});

	it("quotes only hooks and constants that exist in app source", () => {
		const missing: string[] = [];
		for (const { path, quoted } of docs) {
			for (const [name, line] of quoted) {
				if (name in OWNED_ELSEWHERE || REMOVED_ON_PURPOSE.includes(name)) continue;
				if (!ids.has(name)) missing.push(`${path}:${line}  \`${name}\` does not exist`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("keeps the outside-app allowlist honest", () => {
		for (const [name, owner] of Object.entries(OWNED_ELSEWHERE)) {
			const source = readFileSync(join(repoRoot, owner), "utf8");
			expect(source, `${owner} no longer declares ${name}`).toContain(name);
		}
	});

	it("keeps the removed-on-purpose list honest", () => {
		for (const name of REMOVED_ON_PURPOSE) {
			expect(ids.has(name), `${name} is back in app/src - drop it from the list`).toBe(false);
		}
	});

	/**
	 * The identifier scan above cannot see this one.
	 *
	 * These docs documented an `environmentId` option on `useVariableResolver`
	 * that nothing has ever accepted - the hook reads the active environment
	 * from the session store itself. `environmentId` is a real identifier
	 * elsewhere in the app, and the drifted call sits inside a fenced block, so
	 * both of the scan's rules pass it. A wrong *option* is worse than a wrong
	 * name too: it reads as a knob, so a caller writes one and silently gets
	 * the session store's environment instead of the one they asked for.
	 *
	 * So this reads the option keys out of the interface and holds every
	 * documented call to them - fenced blocks included, since a code sample is
	 * exactly where someone copies a call from.
	 */
	it("documents only options the resolver hook accepts", () => {
		const source = readFileSync(join(here, "hooks", "useVariableResolver.ts"), "utf8");
		const body = source.match(/interface UseVariableResolverOptions \{([^}]*)\}/)?.[1];
		expect(body, "UseVariableResolverOptions was renamed - update this guard").toBeTruthy();

		const accepted = new Set([...body!.matchAll(/(\w+)\??\s*:/g)].map((m) => m[1]));
		expect(accepted.size).toBeGreaterThan(0);

		const offences: string[] = [];
		let calls = 0;
		for (const path of DOCS) {
			readFileSync(join(repoRoot, path), "utf8")
				.split(/\r?\n/)
				.forEach((line, i) => {
					for (const call of line.matchAll(/useVariableResolver\(\{([^}]*)\}/g)) {
						calls++;
						// One key per comma-separated entry, and only what comes
						// before `?` or `:` - so `collectionId`,
						// `collectionId?: string` and `collectionId: id` all
						// reduce to the key, and a type name is never read as one.
						for (const entry of call[1].split(",")) {
							const key = entry.trim().split(/[?:]/)[0].trim();
							if (!key || accepted.has(key)) continue;
							offences.push(
								`${path}:${i + 1}  \`${key}\` is not an option (accepted: ${[...accepted].join(", ")})`
							);
						}
					}
				});
		}

		// A guard that matched no call would pass on a doc that had stopped
		// mentioning the hook at all, which is not the same as being correct.
		expect(calls, "no documented useVariableResolver call was found").toBeGreaterThan(0);
		expect(offences).toEqual([]);
	});
});

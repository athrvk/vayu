/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Pins `isScenarioOnlyKind` to the engine's catalogue (#3050). The catalogue
 * has no "scenario only" flag - `load_strategy.cpp` decides it with a
 * whitelist - so the renderer's copy is held to the fixture instead:
 * `engine/tests/fixtures/element-kinds.json`, written by the engine's test run
 * off the live registry and routed here through `ENGINE_READING_GUARDS`.
 *
 * Mutation check: drop `"metric."` from `SCENARIO_ONLY_FAMILIES` and both
 * cases redden; add a `control.*` kind to the engine and the second does. The
 * accepted-set cases (#3070) redden when `ACCEPTED_BY_NAME` loses a name, when
 * the C++ array gains one, and when a new catalogue kind is neither accepted,
 * collection-only, a disable nor flagged by `isScenarioOnlyKind`.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import type { ElementKindSchema } from "@/types";
import { COLLECTION_ONLY_KINDS } from "../../utils/elements-parts";
import { isScenarioOnlyKind } from "./scenario-only";

const [FIXTURE_PATH, LOAD_STRATEGY_PATH] =
	ENGINE_READING_GUARDS.scenarioOnlyKinds.paths.map(fromRepoRoot);

/**
 * The kinds a single-request run's `requestElements` accepts by name: the ten
 * in `REQUEST_ELEMENTS_SUPPORTED_KINDS` (`load_strategy.cpp`). Written out once,
 * here; the source scan below holds it to the C++ array. The engine also
 * accepts every kind whose `hotPathClass` is `script`, by class rather than by
 * name.
 */
const ACCEPTED_BY_NAME = [
	"assert.contains",
	"assert.duration",
	"assert.jsonpath",
	"assert.size",
	"assert.status",
	"extract.boundary",
	"extract.header",
	"extract.json",
	"extract.regex",
	"timer.think",
];

/** The string literals of `REQUEST_ELEMENTS_SUPPORTED_KINDS`' initialiser. */
function supportedKindsIn(source: string): string[] {
	const initialiser = /REQUEST_ELEMENTS_SUPPORTED_KINDS\{([^}]*)\}/.exec(source)?.[1] ?? "";
	return [...initialiser.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe.runIf(existsSync(FIXTURE_PATH) && existsSync(LOAD_STRATEGY_PATH))(
	"scenario-only kinds conformance (fixture present)",
	() => {
		const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ElementKindSchema[];

		it("scanned a non-empty fixture (guards the scan itself)", () => {
			expect(fixture.length).toBeGreaterThan(0);
		});

		it("flags exactly the kinds the engine refuses on a single-request run", () => {
			const flagged = fixture.filter((k) => isScenarioOnlyKind(k.kind)).map((k) => k.kind);

			expect(flagged.sort()).toEqual([
				"control.if",
				"control.loop",
				"control.once",
				"control.switch",
				"control.throughput",
				"control.transaction",
				"metric.record",
				"timer.pacing",
				"timer.throughput",
			]);
		});

		it("flags every controller and metric kind, so a new one cannot slip past the prefix", () => {
			const scenarioFamilies = new Set(["controller", "transaction", "metric"]);
			const unflagged = fixture
				.filter((k) => scenarioFamilies.has(k.category) && !isScenarioOnlyKind(k.kind))
				.map((k) => k.kind);

			expect(unflagged).toEqual([]);
		});

		it("keeps ACCEPTED_BY_NAME equal to the engine's REQUEST_ELEMENTS_SUPPORTED_KINDS (#3070)", () => {
			const fromSource = supportedKindsIn(readFileSync(LOAD_STRATEGY_PATH, "utf8"));

			expect(fromSource.length).toBeGreaterThan(0);
			expect([...fromSource].sort()).toEqual([...ACCEPTED_BY_NAME].sort());
		});

		it("accounts for every catalogue kind as accepted, scenario-only, collection-only or a disable (#3070)", () => {
			const engineAccepts = (k: ElementKindSchema) =>
				ACCEPTED_BY_NAME.includes(k.kind) || k.hotPathClass === "script";
			const handled = (k: ElementKindSchema) =>
				k.collectionOnly ||
				k.kind === "inherit.disable" ||
				engineAccepts(k) ||
				isScenarioOnlyKind(k.kind);

			expect(fixture.filter((k) => !handled(k)).map((k) => k.kind)).toEqual([]);
			// The renderer must not block a kind the engine accepts, and every name
			// the engine lists must still exist, or the list is stale.
			expect(fixture.filter((k) => engineAccepts(k) && isScenarioOnlyKind(k.kind))).toEqual(
				[]
			);
			expect(ACCEPTED_BY_NAME.filter((n) => !fixture.some((k) => k.kind === n))).toEqual([]);
			expect(fixture.some((k) => k.hotPathClass === "script")).toBe(true);
		});

		it("holds COLLECTION_ONLY_KINDS to the catalogue's collectionOnly kinds (#3070)", () => {
			const catalogue = fixture.filter((k) => k.collectionOnly).map((k) => k.kind);

			expect(catalogue.length).toBeGreaterThan(0);
			expect([...COLLECTION_ONLY_KINDS].sort()).toEqual(catalogue.sort());
		});
	}
);

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
 * cases redden; add a `control.*` kind to the engine and the second does.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import type { ElementKindSchema } from "@/types";
import { isScenarioOnlyKind } from "./scenario-only";

const [FIXTURE_PATH] = ENGINE_READING_GUARDS.scenarioOnlyKinds.paths.map(fromRepoRoot);

describe.runIf(existsSync(FIXTURE_PATH))(
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
	}
);

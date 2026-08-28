/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The dialog promises a range; the engine enforces one. When they disagree the
 * user finds out at submit time, as a 400 with no field on it.
 *
 * `load-test.ts` states the invariant - every advertised range sits inside the
 * engine's guard - but nothing checked it, and `maxInFlight` drifted the moment
 * the engine grew an explicit bound (#324): the dialog offered up to 1,000,000
 * against an engine ceiling of 10,000, and `NumberField` passes min/max through
 * as HTML attributes without clamping, so typing 20,000 into a field labelled
 * "up to 1,000,000" was a rejected run.
 *
 * This reads the engine's own header rather than a hand-copied number, which is
 * what makes it a drift guard instead of a restatement: move either side and it
 * fails.
 *
 * The MCP schema holds a third copy of the `maxInFlight` bound and cannot be
 * checked from here - `src/` may not import from `electron/`, and the type-check
 * enforces it. That link is pinned from the other end, in
 * `electron/mcp/tools.test.ts`, which may import `@/constants` and so ties the
 * schema to the ceiling this file ties to the engine.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { LOAD_TEST_CEILING_BOUNDS, LOAD_TEST_DEFAULTS, LOAD_TEST_LIMITS } from "./load-test";

/**
 * The engine files this reads, held in the testkit rather than spelled here:
 * the workflow filter that routes an edit to one of them back to this suite is
 * compared against the union of every guard's list (`routed-inputs.test.ts`).
 */
const [CONSTANTS_HPP, EXECUTION_CPP] = ENGINE_READING_GUARDS.loadTestBounds.paths.map(fromRepoRoot);
const constantsHpp = readFileSync(CONSTANTS_HPP, "utf8");
const executionCpp = readFileSync(EXECUTION_CPP, "utf8");

/**
 * One `constexpr <type> NAME = <expr>;` from the engine header, evaluated.
 *
 * The expression grammar is deliberately tiny - a product of integer literals
 * and other constants in this header, with `static_cast<>` and namespace
 * qualifiers stripped - because that is all the run-config guards use, and
 * anything richer should fail loudly here rather than be guessed at. It has to
 * evaluate rather than pattern-match a literal: `MAX_CONCURRENCY` is written as
 * `10 * event_loop::MAX_CONCURRENT`, and a guard that could not read it would
 * simply not guard the field it names.
 */
function engineConstant(name: string, seen: string[] = []): number {
	expect(seen, `cyclic definition reaching ${name} in constants.hpp`).not.toContain(name);
	const match = constantsHpp.match(
		new RegExp(String.raw`constexpr\s+\w+\s+${name}\s*=\s*([^;]+);`)
	);
	expect(match, `${name} not found as a constexpr in constants.hpp`).not.toBeNull();
	const factors = match![1]
		.replace(/static_cast<[^>]*>/g, "")
		.split("*")
		.map((factor) => factor.replace(/[()\s]/g, ""));
	return factors.reduce((product, factor) => {
		if (/^\d[\d']*$/.test(factor)) return product * Number(factor.replace(/'/g, ""));
		const referenced = factor.split("::").pop() ?? "";
		expect(referenced, `unsupported expression "${match![1].trim()}" for ${name}`).toMatch(
			/^[A-Za-z_]\w*$/
		);
		return product * engineConstant(referenced, [...seen, name]);
	}, 1);
}

describe("load-test limits parity with the engine", () => {
	it("read non-empty engine sources", () => {
		// CLAUDE.md's documented failure mode: a source-scanning guard that reads
		// "" passes every assertion below without checking anything.
		expect(constantsHpp.length).toBeGreaterThan(0);
		expect(executionCpp.length).toBeGreaterThan(0);
	});

	it("advertises exactly the engine's maxInFlight ceiling", () => {
		// Exact, not "inside": maxInFlight is a backpressure ceiling, and the
		// engine's own default is max(targetRps * 10, 1000) - 500,000 at the
		// dialog's 50k RPS maximum - so a UI ceiling below the engine's would
		// refuse ceilings the engine picks for itself when the field is omitted.
		expect(LOAD_TEST_LIMITS.MAX_IN_FLIGHT.MAX).toBe(engineConstant("MAX_IN_FLIGHT"));
	});

	it("uses that constant as the route's maxInFlight bound", () => {
		// The constant existing is not the same as the validator reading it; a
		// bound left on MAX_CONCURRENCY is the exact defect this issue is about.
		expect(executionCpp).toMatch(/\{\s*"maxInFlight",\s*1,\s*limits::MAX_IN_FLIGHT\b/);
	});

	it("keeps the backpressure ceiling distinct from the connection guard", () => {
		// They bound different things - an eager curl-handle pre-allocation
		// versus a counter of outstanding requests - so collapsing them back
		// into one number is a regression even if both sides move together.
		expect(engineConstant("MAX_IN_FLIGHT")).toBeGreaterThan(engineConstant("MAX_CONCURRENCY"));
	});

	it("lets a user's connection ceiling reach the engine's guard and no further", () => {
		// `concurrency` is the one dialog ceiling the user can move, and
		// LOAD_TEST_CEILING_BOUNDS.MAX is documented as the engine's own guard.
		expect(LOAD_TEST_CEILING_BOUNDS.concurrency.MAX).toBe(engineConstant("MAX_CONCURRENCY"));
	});

	it("keeps every shipped connection range inside that guard", () => {
		const guard = engineConstant("MAX_CONCURRENCY");
		for (const key of ["CONCURRENCY", "START_CONCURRENCY"] as const) {
			expect(LOAD_TEST_LIMITS[key].MAX).toBeLessThanOrEqual(guard);
		}
	});

	// --- The stream caps (issue #576) --------------------------------------
	//
	// Both endpoints read these through one parser (`read_stream_flag`), so a
	// value this dialog can reach and the engine refuses is a run that never
	// starts, reported as an opaque 400. Exact rather than "inside", for the
	// same reason maxInFlight is: the dialog is the only place a user sees
	// these numbers, so its range has to be the engine's.

	it("advertises exactly the engine's stream-duration range, in seconds", () => {
		expect(LOAD_TEST_LIMITS.STREAM_DURATION_S.MIN * 1000).toBe(
			engineConstant("MIN_STREAM_DURATION_MS")
		);
		expect(LOAD_TEST_LIMITS.STREAM_DURATION_S.MAX * 1000).toBe(
			engineConstant("STREAM_DURATION_MS_CEILING")
		);
	});

	it("advertises exactly the engine's stream-event range", () => {
		expect(LOAD_TEST_LIMITS.STREAM_MAX_EVENTS.MIN).toBe(engineConstant("MIN_STREAM_EVENTS"));
		expect(LOAD_TEST_LIMITS.STREAM_MAX_EVENTS.MAX).toBe(
			engineConstant("STREAM_EVENTS_CEILING")
		);
	});

	it("opens the dialog on the caps a run would get if it sent none", () => {
		// The defaults seed the engine's `sseMaxStreamDurationMs` /
		// `sseMaxStreamEvents` settings, so a dialog opening on different
		// numbers would show bounds that are not the ones in force for a user
		// who never touched the fields.
		expect(LOAD_TEST_DEFAULTS.STREAM_DURATION_S * 1000).toBe(
			engineConstant("MAX_STREAM_DURATION_MS")
		);
		expect(LOAD_TEST_DEFAULTS.STREAM_MAX_EVENTS).toBe(engineConstant("MAX_STREAM_EVENTS"));
	});

	it("reads the stream flag through the shared parser on POST /runs", () => {
		// The constants agreeing is not the same as the route reading them: the
		// refusal this replaced was a flat `return "'stream' is not valid on a
		// run"`, and leaving that in place would make every assertion above
		// describe a payload the endpoint still rejects.
		expect(executionCpp).toMatch(/read_stream_flag\s*\(config\)/);
	});
});

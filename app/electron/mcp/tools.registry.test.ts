/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { toolCatalog, TOOLS } from "./tools.js";
import { descriptionOf } from "./tools.testkit.js";

describe("tool registry", () => {
	test("exposes stable, unique tool names", () => {
		const names = TOOLS.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names).toContain("run_request");
		expect(names).toContain("start_load_run");
		expect(names).toContain("compare_runs");
		expect(names).toContain("export_run_report");
	});

	test("every tool has a valid category", () => {
		for (const t of TOOLS) {
			expect(["read", "execute", "write", "load"]).toContain(t.category);
		}
	});

	test("traffic-sending tools are 'execute', not 'write'", () => {
		const byName = new Map(TOOLS.map((t) => [t.name, t]));
		expect(byName.get("run_request")?.category).toBe("execute");
		expect(byName.get("run_collection_smoke")?.category).toBe("execute");
		// The 'write' category is reserved for data/config mutation.
		expect(byName.get("create_request")?.category).toBe("write");
		expect(byName.get("update_environment")?.category).toBe("write");
		expect(byName.get("update_engine_config")?.category).toBe("write");
	});

	test("the collection/request CRUD verbs are write-category, deletes hinted destructive", () => {
		const byName = new Map(TOOLS.map((t) => [t.name, t]));
		for (const name of [
			"create_collection",
			"update_collection",
			"delete_collection",
			"update_request",
			"delete_request",
		]) {
			expect(byName.get(name)?.category, name).toBe("write");
		}
		// The hint is what tells a client to treat the call as irreversible.
		expect(byName.get("delete_collection")?.annotations.destructiveHint).toBe(true);
		expect(byName.get("delete_request")?.annotations.destructiveHint).toBe(true);
	});

	// Mutation check: restoring "it can differ slightly from the report's
	// summary.errorRate" in reads.tools.ts fails both assertions below.
	test("list_runs says its errorRate shares the report's failure definition, with no 'differ slightly' hedge", () => {
		const description = descriptionOf(TOOLS.find((t) => t.name === "list_runs"));
		expect(description).not.toBe("");
		expect(description).not.toContain("differ slightly");
		expect(description).toContain("same failure definition");
	});

	// Mutation check (#2820, #3537): drop the assertion sentence from list_runs
	// in reads.tools.ts, or the block's keys from it, and this fails.
	test("list_runs names the assertion block and counts a load row carries and says errorRate excludes them", () => {
		const description = descriptionOf(TOOLS.find((t) => t.name === "list_runs"));
		expect(description).toContain(
			"A load run that asserted or errored also carries `assertions` {exact, sampled, errored, teardownFailed}"
		);
		expect(description).toContain("`assertionsPassed`/`assertionsFailed` over both");
		expect(description).toContain("never folded into errorRate");
		expect(description).toContain("omitted for every other run");
	});

	// Mutation check (#3568): drop the "Every tick carries phase: ..." sentence
	// from get_live_metrics in runs.tools.ts and this fails.
	test("get_live_metrics names the phase every tick carries and its five values", () => {
		const description = descriptionOf(TOOLS.find((t) => t.name === "get_live_metrics"));
		expect(description).toContain("Every tick carries phase");
		for (const phase of ["setup", "sending", "draining", "summarising", "settled"]) {
			expect(description, phase).toContain(phase);
		}
	});

	test("toolCatalog mirrors the registry as IPC-safe metadata", () => {
		const catalog = toolCatalog();
		expect(catalog).toHaveLength(TOOLS.length);
		const get = catalog.find((t) => t.name === "get_engine_config");
		expect(get).toMatchObject({ category: "read" });
		const upd = catalog.find((t) => t.name === "update_engine_config");
		expect(upd).toMatchObject({ category: "write" });
		// Metadata only - no handler leaks across the boundary.
		expect(get).not.toHaveProperty("handler");
	});
});

/**
 * Descriptions that once said something the tools no longer do (#2446): a
 * format the engine reads that the description left out, and a sentence that
 * denied a call the tool answers.
 */
describe("description claims that must stay true", () => {
	const describe_ = (name: string) => descriptionOf(TOOLS.find((t) => t.name === name));

	test("import_document names every format the engine reads, JMeter included", () => {
		expect(describe_("import_document")).toMatch(/a JMeter test plan/);
	});

	test("list_requests does not claim a sub-collection's requests need no separate call", () => {
		const text = describe_("list_requests");
		expect(text).not.toMatch(/no separate call/i);
		expect(text).toMatch(/calling this again with the sub-collection id/);
	});
});

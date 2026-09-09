/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One case per family template (issue #1608's own acceptance criteria name
 * three of these verbatim: `in [200]`, `wait 500 ms`, a script's first
 * line), plus the two fallbacks every kind shares - the kind's own
 * description when nothing configured suffices for a template, and the
 * `key: value` pairing for a kind this module has no template for at all.
 *
 * Mutation check, done by hand: comment out `TEMPLATES["assert.status"]` (or
 * any one entry) so it falls through to `summarizeGeneric` - the
 * `assert.status` case below reds, asserting `in [200, 201]` where the
 * generic fallback would print `in: [200,201]` instead.
 */

import { describe, it, expect } from "vitest";
import type { ElementDef, ElementKindSchema } from "@/types";
import { summarizeElement } from "./summarize-element";

function kind(overrides: Partial<ElementKindSchema> & { kind: string }): ElementKindSchema {
	return {
		version: 1,
		label: overrides.kind,
		description: `${overrides.kind} description`,
		category: "test",
		hotPathClass: "declarative",
		collectionOnly: false,
		configSchema: { type: "object", properties: {} },
		phases: [],
		...overrides,
	};
}

function element(kindName: string, config: Record<string, unknown>): ElementDef {
	return { id: "el_1", kind: kindName, enabled: true, config };
}

describe("summarizeElement - assert.status", () => {
	const k = kind({ kind: "assert.status" });

	it("lists the accepted codes", () => {
		expect(summarizeElement(element("assert.status", { in: [200, 201] }), k)).toBe(
			"in [200, 201]"
		);
	});

	it("reads a range when there is no in-list", () => {
		expect(
			summarizeElement(element("assert.status", { range: { min: 200, max: 299 } }), k)
		).toBe("200 - 299");
	});

	it("falls back to the kind's description when unconfigured", () => {
		expect(summarizeElement(element("assert.status", {}), k)).toBe(k.description);
	});
});

describe("summarizeElement - assert.jsonpath", () => {
	const k = kind({ kind: "assert.jsonpath" });

	it("shows an equality check", () => {
		expect(
			summarizeElement(element("assert.jsonpath", { path: "$.ok", expected: true }), k)
		).toBe("$.ok == true");
	});

	it("shows a regex check", () => {
		expect(
			summarizeElement(element("assert.jsonpath", { path: "$.id", regex: "^[0-9]+$" }), k)
		).toBe("$.id matches ^[0-9]+$");
	});

	it("shows an existence check", () => {
		expect(
			summarizeElement(element("assert.jsonpath", { path: "$.id", exists: true }), k)
		).toBe("$.id exists");
	});

	it("falls back to the kind's description without a path", () => {
		expect(summarizeElement(element("assert.jsonpath", {}), k)).toBe(k.description);
	});
});

describe("summarizeElement - extract.json", () => {
	const k = kind({ kind: "extract.json" });

	it("shows the path, the variable and the scope", () => {
		expect(
			summarizeElement(
				element("extract.json", { path: "$.token", variable: "token", scope: "env" }),
				k
			)
		).toBe("$.token → token (env)");
	});

	it("falls back to the kind's description without a variable", () => {
		expect(summarizeElement(element("extract.json", { path: "$.token" }), k)).toBe(
			k.description
		);
	});
});

describe("summarizeElement - timer.think", () => {
	const k = kind({ kind: "timer.think" });

	it("shows a fixed wait", () => {
		expect(summarizeElement(element("timer.think", { ms: 500 }), k)).toBe("wait 500 ms");
	});

	it("shows a gaussian wait's mean", () => {
		expect(
			summarizeElement(
				element("timer.think", { gaussian: { meanMs: 500, deviationMs: 50 } }),
				k
			)
		).toBe("wait ~500 ms");
	});

	it("shows a uniform range", () => {
		expect(summarizeElement(element("timer.think", { minMs: 100, maxMs: 300 }), k)).toBe(
			"wait 100-300 ms"
		);
	});

	it("falls back to the kind's description when unconfigured", () => {
		expect(summarizeElement(element("timer.think", {}), k)).toBe(k.description);
	});
});

describe("summarizeElement - timer.pacing", () => {
	const k = kind({ kind: "timer.pacing" });

	it("shows the cadence", () => {
		expect(summarizeElement(element("timer.pacing", { everyMs: 1000 }), k)).toBe(
			"every 1000 ms"
		);
	});

	it("names per-user pacing", () => {
		expect(summarizeElement(element("timer.pacing", { everyMs: 1000, perUser: true }), k)).toBe(
			"every 1000 ms · per user"
		);
	});

	it("falls back to the kind's description without a cadence", () => {
		expect(summarizeElement(element("timer.pacing", {}), k)).toBe(k.description);
	});
});

describe("summarizeElement - control.if", () => {
	const k = kind({ kind: "control.if" });

	it("shows the condition verbatim", () => {
		expect(summarizeElement(element("control.if", { condition: "{{env}} == prod" }), k)).toBe(
			"{{env}} == prod"
		);
	});

	it("falls back to the kind's description without a condition", () => {
		expect(summarizeElement(element("control.if", {}), k)).toBe(k.description);
	});
});

describe("summarizeElement - metric.record", () => {
	const k = kind({ kind: "metric.record" });

	it("shows the metric name", () => {
		expect(summarizeElement(element("metric.record", { name: "latency" }), k)).toBe("latency");
	});

	it("falls back to the kind's description without a name", () => {
		expect(summarizeElement(element("metric.record", {}), k)).toBe(k.description);
	});
});

describe("summarizeElement - script kinds", () => {
	it.each(["script.pre", "script.post", "script.setup", "script.teardown"] as const)(
		"shows %s's first non-blank line",
		(kindName) => {
			const k = kind({ kind: kindName });
			expect(
				summarizeElement(
					element(kindName, { script: "\n  pm.test('ok', () => {});\nmore();" }),
					k
				)
			).toBe("pm.test('ok', () => {});");
		}
	);

	it("falls back to the kind's description for a blank script", () => {
		const k = kind({ kind: "script.pre" });
		expect(summarizeElement(element("script.pre", { script: "   \n  " }), k)).toBe(
			k.description
		);
	});
});

describe("summarizeElement - a kind with no template", () => {
	const k = kind({ kind: "control.throughput" });

	it("shows the first two configured properties as key: value", () => {
		expect(
			summarizeElement(
				element("control.throughput", { everyN: 10, percent: 50, perUser: true }),
				k
			)
		).toBe("everyN: 10, percent: 50");
	});

	it("displays an array value bracketed", () => {
		expect(summarizeElement(element("control.throughput", { codes: [1, 2, 3] }), k)).toBe(
			"codes: [1, 2, 3]"
		);
	});

	it("falls back to the kind's description when unconfigured", () => {
		expect(summarizeElement(element("control.throughput", {}), k)).toBe(k.description);
	});

	it("falls back to the kind's own description when the kind is unknown", () => {
		expect(summarizeElement(element("control.throughput", {}), undefined)).toBe("");
	});
});

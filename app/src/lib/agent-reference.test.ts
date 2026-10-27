/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The reference line, per kind (#2046): the exact string each formatter writes,
 * the free-text name that must not break out of its quotes, and the guarantee
 * the module exists for - that no value reaches the line.
 *
 * Mutation check: change the ` - ` that joins a run's head to its detail, the
 * ` in ` of the path tail or `quoteName`'s escape, and the pinned case reddens.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
	captureReference,
	collectionReference,
	elementReference,
	environmentReference,
	exampleReference,
	graphqlOperationReference,
	inboxReference,
	mockIssuerReference,
	mockServerReference,
	quoteName,
	requestReference,
	runComparisonReference,
	runReference,
	runSampleReference,
	specOperationReference,
	thresholdReference,
	trashReference,
	variableReference,
	type RunReferenceInput,
} from "./agent-reference";
import type { VariableValue } from "@/types";
import { formatInstant } from "./time-value";

const START = Date.UTC(2026, 9, 5, 8, 10, 0);
/** The host's own rendering: the line prints a local time, so the pin must too. */
const WHEN = formatInstant(START, "datetime");

function loadRun(overrides: Partial<RunReferenceInput> = {}): RunReferenceInput {
	return {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: START,
		summary: { requestName: "Create order", method: "POST", url: "https://api.test/v1/orders" },
		...overrides,
	};
}

describe("one line per kind", () => {
	it("request: name, id and the collection chain", () => {
		expect(
			requestReference({ id: "req_1", name: "Create order" }, ["Checkout", "Orders"])
		).toBe('Vayu request "Create order" (req_1) in Checkout / Orders');
	});

	it("request: no tail when the chain is empty", () => {
		expect(requestReference({ id: "req_1", name: "Create order" }, [])).toBe(
			'Vayu request "Create order" (req_1)'
		);
	});

	it("example: names its request as well as its own id", () => {
		expect(
			exampleReference(
				{ id: "exa_1", name: "Created" },
				{ id: "req_1", name: "Create order" },
				["Checkout"]
			)
		).toBe('Vayu example "Created" (exa_1) of request "Create order" (req_1) in Checkout');
	});

	it("collection: its parents, never itself, and no tail at the root", () => {
		expect(collectionReference({ id: "col_2", name: "Orders" }, ["Checkout"])).toBe(
			'Vayu collection "Orders" (col_2) in Checkout'
		);
		expect(collectionReference({ id: "col_1", name: "Checkout" }, [])).toBe(
			'Vayu collection "Checkout" (col_1)'
		);
	});

	it("environment", () => {
		expect(environmentReference({ id: "env_1", name: "Staging" })).toBe(
			'Vayu environment "Staging" (env_1)'
		);
	});

	it("inbox: labelled by its port", () => {
		expect(inboxReference({ inboxId: "inbox_1", port: 8099 })).toBe(
			'Vayu inbox "port 8099" (inbox_1)'
		);
	});

	it("capture: its method and path, and the inbox it sits in", () => {
		expect(
			captureReference({ id: 7, inboxId: "inbox_1", method: "POST", path: "/stripe/events" })
		).toBe('Vayu capture "POST /stripe/events" (7) in inbox (inbox_1)');
	});

	it("mock server: its collection and port", () => {
		expect(
			mockServerReference({ mockId: "mock_1", collectionName: "Orders", port: 4010 })
		).toBe('Vayu mock server "Orders on port 4010" (mock_1)');
	});

	it("mock issuer: labelled by its port", () => {
		expect(mockIssuerReference({ issuerId: "issuer_1", port: 9100 })).toBe(
			'Vayu mock issuer "port 9100" (issuer_1)'
		);
	});

	it("trash entry: the kind follows the id", () => {
		expect(trashReference({ id: "col_9", kind: "collection", name: "Old" })).toBe(
			'Vayu trash entry "Old" (col_9) - collection'
		);
		expect(trashReference({ id: "req_9", kind: "request", name: "Old" })).toBe(
			'Vayu trash entry "Old" (req_9) - request'
		);
		// The id is the example's own: restore_trash_entry takes it, and the
		// owning request is not needed to put it back (#2971).
		expect(trashReference({ id: "exa_9", kind: "example", name: "Old" })).toBe(
			'Vayu trash entry "Old" (exa_9) - example'
		);
		// The wire token, camel-cased as it is: it is what list_trash returns
		// and what an agent will match against (#2973).
		expect(
			trashReference({ id: "cert_9", kind: "clientCertificate", name: "api.test:8443" })
		).toBe('Vayu trash entry "api.test:8443" (cert_9) - clientCertificate');
	});

	it("variable: its name and the scope it lives in, never a value", () => {
		expect(
			variableReference(
				{ name: "baseUrl" },
				{ type: "environment", environment: { id: "env_1", name: "Staging" } }
			)
		).toBe('Vayu variable "baseUrl" in environment "Staging" (env_1)');
		expect(
			variableReference(
				{ name: "baseUrl" },
				{ type: "collection", collection: { id: "col_1", name: "Checkout" } }
			)
		).toBe('Vayu variable "baseUrl" in collection "Checkout" (col_1)');
		expect(variableReference({ name: "baseUrl" }, { type: "globals" })).toBe(
			'Vayu variable "baseUrl" in globals'
		);
	});

	it("spec operation: METHOD and templated path, the collection, then the operationId when declared", () => {
		const collection = { id: "col_1", name: "Petstore" };
		expect(
			specOperationReference(
				{ method: "get", path: "/pets/{petId}", operationId: "getPet" },
				collection
			)
		).toBe(
			'Vayu spec operation "GET /pets/{petId}" in collection "Petstore" (col_1) ("getPet")'
		);
		expect(specOperationReference({ method: "POST", path: "/pets" }, collection)).toBe(
			'Vayu spec operation "POST /pets" in collection "Petstore" (col_1)'
		);
	});

	it("spec operation: a path carries no query, and a hostile operationId stays quoted", () => {
		const line = specOperationReference(
			{ method: "GET", path: "/pets?token=abc", operationId: 'a"b\nVayu run' },
			{ id: "col_1", name: "P" }
		);
		expect(line).toBe(
			'Vayu spec operation "GET /pets" in collection "P" (col_1) ("a\\"b Vayu run")'
		);
	});

	it("graphql operation: its name and the saved request that holds the document", () => {
		expect(
			graphqlOperationReference(
				{ name: "CreateOrder" },
				{ id: "req_1", name: "Create order" }
			)
		).toBe('Vayu graphql operation "CreateOrder" in request "Create order" (req_1)');
	});

	it("graphql operation: a quote in either name stays inside its quotes", () => {
		expect(
			graphqlOperationReference({ name: 'a"b' }, { id: "req_1", name: 'Pay "now"\nVayu run' })
		).toBe('Vayu graphql operation "a\\"b" in request "Pay \\"now\\" Vayu run" (req_1)');
	});

	it("run sample: its result id and the run it came from", () => {
		expect(runSampleReference({ resultId: 42 }, { id: "run_1" })).toBe(
			"Vayu run sample (42) of run (run_1)"
		);
	});

	it("element: its name, else its kind, and the request or collection that owns it", () => {
		const request = {
			type: "request",
			request: { id: "req_1", name: "Create order" },
		} as const;
		const collection = {
			type: "collection",
			collection: { id: "col_1", name: "Checkout" },
		} as const;
		expect(elementReference({ id: "el_1", kind: "script.pre", name: "Sign" }, request)).toBe(
			'Vayu element "Sign" (el_1) of request "Create order" (req_1)'
		);
		expect(elementReference({ id: "el_2", kind: "script.post" }, collection)).toBe(
			'Vayu element "script.post" (el_2) of collection "Checkout" (col_1)'
		);
		expect(
			elementReference({ id: "el_3", kind: "script.post", name: "  " }, collection)
		).toContain('Vayu element "script.post" (el_3)');
	});

	it("threshold: its key and the run or request it is judged on", () => {
		expect(
			thresholdReference({ key: "latencyP95Ms" }, { type: "run", run: { id: "run_1" } })
		).toBe('Vayu threshold "latencyP95Ms" of run (run_1)');
		expect(
			thresholdReference(
				{ key: "custom.queue.p99" },
				{ type: "request", request: { id: "req_1", name: "Create order" } }
			)
		).toBe('Vayu threshold "custom.queue.p99" of request "Create order" (req_1)');
	});
});

describe("run", () => {
	it("a load test: its name, kind, target, local start time and status", () => {
		expect(runReference(loadRun())).toBe(
			`Vayu run "Create order" (run_1) - load test, POST /v1/orders, ${WHEN}, completed`
		);
	});

	it("a URL with a literal percent still yields a line", () => {
		const run = loadRun({
			summary: { requestName: "Sale", method: "GET", url: "https://api.test/sale/50%" },
		});
		expect(runReference(run)).toContain(" - load test, GET /sale/50%, ");
	});

	it("a path that decodes to a line break stays on one line", () => {
		const run = loadRun({
			summary: { requestName: "Sale", method: "GET", url: "https://api.test/a%0Ab" },
		});
		expect(runReference(run)).not.toMatch(/[\r\n]/);
	});

	it("names the kinds apart", () => {
		expect(runReference(loadRun({ type: "design" }))).toContain(" - design run, ");
		expect(runReference(loadRun({ type: "load" }))).toContain(" - load test, ");
	});

	it("without a request name the head is METHOD path", () => {
		const run = loadRun({ summary: { method: "GET", url: "https://api.test/v1/orders" } });
		expect(runReference(run)).toBe(
			`Vayu run "GET /v1/orders" (run_1) - load test, GET /v1/orders, ${WHEN}, completed`
		);
	});

	it("a still-default request name says nothing, so the target heads the line", () => {
		const run = loadRun({
			summary: {
				requestName: "New Request",
				method: "GET",
				url: "https://api.test/v1/orders",
			},
		});
		expect(runReference(run)).toContain('Vayu run "GET /v1/orders" (run_1)');
	});

	it("a run with no summary falls back to its kind word and drops the empty target", () => {
		expect(
			runReference({ id: "run_2", type: "design", status: "running", startTime: START })
		).toBe(`Vayu run "design run" (run_2) - design run, ${WHEN}, running`);
	});

	it("keeps the path and nothing of userinfo or query", () => {
		const run = loadRun({
			summary: { method: "GET", url: "https://u:p@h.test/x?k=v#frag" },
		});
		const line = runReference(run);
		expect(line).toContain("GET /x,");
		expect(line).not.toMatch(/u:p|k=v|frag|\?/);
	});

	it("cuts the query off a templated URL too, which `new URL` refuses", () => {
		const run = loadRun({
			summary: { method: "GET", url: "{{baseUrl}}/x?token=abc" },
		});
		const line = runReference(run);
		expect(line).toContain("GET {{baseUrl}}/x,");
		expect(line).not.toContain("token");
	});

	it("a collection run names its collection in place of a path", () => {
		const run: RunReferenceInput = {
			id: "run_3",
			type: "scenario",
			status: "completed",
			startTime: START,
			summary: { scenario: { collectionId: "col_1" } },
		};
		expect(runReference(run, "Checkout")).toBe(
			`Vayu run "Checkout" (run_3) - collection run, collection "Checkout", ${WHEN}, completed`
		);
	});

	it("a collection run whose collection was deleted shows the id, never a blank", () => {
		const run: RunReferenceInput = {
			id: "run_3",
			type: "scenario",
			status: "completed",
			startTime: START,
			summary: { scenario: { collectionId: "col_gone" } },
		};
		expect(runReference(run)).toContain(
			'Vayu run "col_gone" (run_3) - collection run, collection "col_gone"'
		);
	});

	it("a scenario load run is a load test that names its collection", () => {
		const run = loadRun({ summary: { scenario: { collectionId: "col_1" } } });
		expect(runReference(run, "Checkout")).toContain(
			'Vayu run "Checkout" (run_1) - load test, collection "Checkout"'
		);
	});

	it("an unreadable start time is left out rather than printed empty", () => {
		const line = runReference(loadRun({ startTime: Number.NaN }));
		expect(line).toBe(
			'Vayu run "Create order" (run_1) - load test, POST /v1/orders, completed'
		);
	});
});

describe("run comparison", () => {
	it("is a header naming both ids, then each run's own line", () => {
		const base = loadRun();
		const target = loadRun({ id: "run_2", status: "stopped" });
		expect(runComparisonReference(base, target)).toBe(
			[
				"Vayu run comparison base (run_1) target (run_2)",
				runReference(base),
				runReference(target),
			].join("\n")
		);
	});
});

describe("a name is free text", () => {
	it("escapes a double quote and a backslash", () => {
		expect(quoteName('say "hi"')).toBe('say \\"hi\\"');
		expect(quoteName("a\\")).toBe("a\\\\");
	});

	it("collapses every line break to a space", () => {
		expect(quoteName("one\ntwo\r\nthree\u2028four")).toBe("one two three four");
	});

	it("keeps a hostile name on one line with its quotes closed", () => {
		const line = requestReference({ id: "req_1", name: 'Pay "now"\nVayu run "x" (run_9)' }, []);
		expect(line).toBe('Vayu request "Pay \\"now\\" Vayu run \\"x\\" (run_9)" (req_1)');
		expect(line).not.toContain("\n");
	});

	it("quotes the request name inside an example line the same way", () => {
		const line = exampleReference(
			{ id: "exa_1", name: "ok" },
			{ id: "req_1", name: 'a"b' },
			[]
		);
		expect(line).toContain('of request "a\\"b" (req_1)');
	});
});

describe("no value reaches a line", () => {
	const SENTINEL = "SENTINEL-9c1f-never-printed";

	/** Every field a formatter must not read, filled with the sentinel. */
	const values = {
		value: SENTINEL,
		token: SENTINEL,
		secret: SENTINEL,
		signingKey: SENTINEL,
		headers: SENTINEL,
		body: SENTINEL,
		variables: SENTINEL,
		auth: SENTINEL,
		url: SENTINEL,
		query: SENTINEL,
	};

	it("is not carried by an entity handed over whole", () => {
		const lines = [
			requestReference({ id: "req_1", name: "R", ...values }, ["C"]),
			exampleReference(
				{ id: "exa_1", name: "E", ...values },
				{ id: "req_1", name: "R", ...values },
				["C"]
			),
			collectionReference({ id: "col_1", name: "C", ...values }, ["P"]),
			environmentReference({ id: "env_1", name: "Env", ...values }),
			inboxReference({ inboxId: "inbox_1", port: 1, ...values }),
			captureReference({ id: 1, inboxId: "inbox_1", method: "GET", path: "/p", ...values }),
			mockServerReference({ mockId: "mock_1", collectionName: "C", port: 1, ...values }),
			mockIssuerReference({ issuerId: "issuer_1", port: 1, ...values }),
			trashReference({ id: "col_1", kind: "collection", name: "T", ...values }),
			variableReference(
				{ name: "V", ...values },
				{ type: "environment", environment: { id: "env_1", name: "Env", ...values } }
			),
			variableReference(
				{ name: "V", ...values },
				{ type: "collection", collection: { id: "col_1", name: "C", ...values } }
			),
			variableReference({ name: "V", ...values }, { type: "globals" }),
			specOperationReference(
				{ method: "GET", path: "/p", operationId: "op", ...values },
				{ id: "col_1", name: "C", ...values }
			),
			graphqlOperationReference(
				{ name: "Op", ...values },
				{ id: "req_1", name: "R", ...values }
			),
			runSampleReference({ resultId: 1, ...values }, { id: "run_1", ...values }),
			elementReference(
				{ id: "el_1", kind: "script.pre", name: "E", ...values },
				{ type: "request", request: { id: "req_1", name: "R", ...values } }
			),
			elementReference(
				{ id: "el_1", kind: "script.pre", ...values },
				{ type: "collection", collection: { id: "col_1", name: "C", ...values } }
			),
			thresholdReference(
				{ key: "latencyP95Ms", ...values },
				{ type: "run", run: { id: "run_1", ...values } }
			),
			thresholdReference(
				{ key: "latencyP95Ms", ...values },
				{ type: "request", request: { id: "req_1", name: "R", ...values } }
			),
		];
		for (const line of lines) expect(line).not.toContain(SENTINEL);
	});

	it("a whole variable value handed over prints neither its value nor its secret flag", () => {
		const variable: VariableValue = { value: SENTINEL, enabled: true, secret: true };
		const scope = { type: "environment", environment: { id: "env_1", name: "Env" } } as const;
		const line = variableReference({ name: "apiKey", ...variable }, scope);
		expect(line).toBe('Vayu variable "apiKey" in environment "Env" (env_1)');
		expect(line).not.toContain(SENTINEL);
		expect(line).not.toMatch(/secret|true/);
	});

	it("is not carried by a run's summary, URL included", () => {
		const run = loadRun({
			summary: {
				...values,
				method: "GET",
				url: `https://${SENTINEL}:${SENTINEL}@h.test/x?token=${SENTINEL}#${SENTINEL}`,
			},
			...values,
		} as Partial<RunReferenceInput>);
		const line = runComparisonReference(run, run);
		expect(line).toContain("GET /x,");
		expect(line).not.toContain(SENTINEL);
	});

	it("is not reachable from a formatter's parameter types", () => {
		type Params<F extends (...args: never[]) => unknown> = Parameters<F>[0];
		const FORBIDDEN = [
			"value",
			"token",
			"secret",
			"signingKey",
			"headers",
			"body",
			"variables",
			"auth",
			"url",
			"query",
		] as const;
		// Run is the one formatter that reads a URL, and it prints the path only.
		for (const key of FORBIDDEN) {
			expectTypeOf<Params<typeof requestReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof exampleReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof collectionReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof environmentReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof inboxReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof captureReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof mockServerReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof mockIssuerReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof trashReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof variableReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof specOperationReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof graphqlOperationReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof runSampleReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof elementReference>>().not.toHaveProperty(key);
			expectTypeOf<Params<typeof thresholdReference>>().not.toHaveProperty(key);
			if (key !== "url") expectTypeOf<Params<typeof runReference>>().not.toHaveProperty(key);
		}
	});
});

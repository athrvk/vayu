/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The reference lines `docs/engine/mcp.md` prints are the formatters' output (#2046).
 *
 * The page teaches an agent the grammar by example, and an example that stops
 * matching the app is the agent being taught a line the app never writes. The
 * fixture below is the one the page names: every entity in it appears in the
 * page's example block, in the same order the formatters are called here.
 *
 * Mutation check: change a separator in `runReference`, or edit one example on
 * the page, and this reddens.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { collectionNamePath } from "@/modules/collections/tree-utils";
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
import { formatInstant } from "./time-value";

const [page] = DOC_READING_GUARDS.agentReference.paths;
const SECTION_HEADING = "### Naming what the user means";

/** The page's fenced blocks under the "Naming what the user means" heading. */
function fencedBlocks(markdown: string): string[][] {
	const start = markdown.indexOf(SECTION_HEADING);
	if (start === -1) return [];
	const rest = markdown.slice(start + SECTION_HEADING.length);
	const end = rest.search(/^### /m);
	const section = end === -1 ? rest : rest.slice(0, end);
	return [...section.matchAll(/^```\n([\s\S]*?)^```$/gm)].map((m) => m[1].trimEnd().split("\n"));
}

/** The example block is the one that starts with the request line; the other is the grammar. */
function exampleLines(markdown: string): string[] {
	return fencedBlocks(markdown).find((lines) => lines[0].startsWith("Vayu request ")) ?? [];
}

const collections = [
	{ id: "col_8e2d4b17-1c3a-4f60-a9d2-5b6c7d8e9f01", name: "Checkout" },
	{
		id: "col_4a6c8e02-9b1d-4f35-a7c8-1d3e5f708192",
		name: "Orders",
		parentId: "col_8e2d4b17-1c3a-4f60-a9d2-5b6c7d8e9f01",
	},
];
const [checkout, orders] = collections;
const request = { id: "req_3f9c1a52-7b0e-4d1a-9c55-0a1b2c3d4e5f", name: "Create order" };
const requestPath = collectionNamePath(orders.id, collections);

/** October 2026, UTC: the page's times are these instants. */
const at = (day: number, hour: number, minute: number) => Date.UTC(2026, 9, day, hour, minute);
const START = at(5, 8, 10);
const FAILED_START = at(5, 9, 30);
const COLLECTION_RUN_START = at(6, 7, 0);
const STOPPED_START = at(7, 8, 10);

const createOrderRun: RunReferenceInput = {
	id: "run_5a7c9e21-4d3b-4a8f-b1c2-d3e4f5a6b7c8",
	type: "load",
	status: "completed",
	startTime: START,
	summary: {
		requestName: "Create order",
		method: "POST",
		// The query is on the URL and must not be on the page.
		url: "https://api.example.test/v1/orders?token=abc",
	},
};
const stoppedRun: RunReferenceInput = {
	...createOrderRun,
	id: "run_e8f0a2b4-6c7d-4e91-b3a5-c7d9e1f30415",
	status: "stopped",
	startTime: STOPPED_START,
};

/** Every reference the page prints, in the page's order. */
const FORMATTED = [
	requestReference(request, requestPath),
	exampleReference(
		{ id: "exa_2d4f6a81-3c5e-4b79-8a1c-6e8f0a2b4c6d", name: "Created" },
		request,
		requestPath
	),
	elementReference(
		{ id: "el_b4d6f8a0-2c1e-4a73-9b5d-7f9a1c3e5b70", kind: "script.pre", name: "Sign payload" },
		{ type: "request", request }
	),
	collectionReference(orders, collectionNamePath(orders.parentId ?? "", collections)),
	collectionReference(checkout, []),
	environmentReference({ id: "env_7c9e1b34-5d6f-4a80-b2c3-e4f5a6b7c8d9", name: "Staging" }),
	variableReference(
		{ name: "baseUrl" },
		{
			type: "environment",
			environment: { id: "env_7c9e1b34-5d6f-4a80-b2c3-e4f5a6b7c8d9", name: "Staging" },
		}
	),
	specOperationReference(
		{ method: "GET", path: "/orders/{orderId}", operationId: "getOrder" },
		orders
	),
	graphqlOperationReference({ name: "CreateOrder" }, request),
	runReference(createOrderRun),
	runReference({
		id: "run_9d1f3b57-2e4c-4b68-a0d1-f2a3b4c5d6e7",
		type: "design",
		status: "failed",
		startTime: FAILED_START,
		summary: { method: "GET", url: "https://api.example.test/v1/orders" },
	}),
	runReference(
		{
			id: "run_c3e5a7b9-1d2f-4c40-8e6a-0b1c2d3e4f50",
			type: "scenario",
			status: "completed",
			startTime: COLLECTION_RUN_START,
			summary: { scenario: { collectionId: checkout.id } },
		},
		checkout.name
	),
	runComparisonReference(createOrderRun, stoppedRun),
	runSampleReference({ resultId: 1042 }, createOrderRun),
	thresholdReference({ key: "latencyP95Ms" }, { type: "run", run: createOrderRun }),
	inboxReference({ inboxId: "inbox_c0d1e2f3-a4b5-4c6d-8e7f-9a0b1c2d3e4f", port: 8099 }),
	captureReference({
		id: 7,
		inboxId: "inbox_c0d1e2f3-a4b5-4c6d-8e7f-9a0b1c2d3e4f",
		method: "POST",
		path: "/stripe/events",
	}),
	mockServerReference({
		mockId: "mock_1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
		collectionName: "Orders",
		port: 4010,
	}),
	mockIssuerReference({ issuerId: "issuer_6f8a0c2e-4b5d-4e71-9a3c-5e7f9b1d3a45", port: 9100 }),
	trashReference({
		id: "col_a1b3c5d7-e9f0-4a2b-8c4d-6e8f0a1b3c5e",
		kind: "collection",
		name: 'Legacy "v1" orders',
	}),
].flatMap((reference) => reference.split("\n"));

const STARTS = [START, FAILED_START, COLLECTION_RUN_START, STOPPED_START];

/**
 * The page shows times as `en-US` in UTC; the formatter prints the host's own
 * locale and zone, so the host's rendering of each start time is swapped for the
 * page's before the comparison.
 */
function pinTimes(lines: string[]): string[] {
	return lines.map((line) =>
		STARTS.reduce(
			(out, start) =>
				out
					.split(formatInstant(start, "datetime"))
					.join(formatInstant(start, "datetime", { locale: "en-US", timeZone: "UTC" })),
			line
		)
	);
}

describe("docs/engine/mcp.md reference examples", () => {
	const markdown = readFileSync(fromRepoRoot(page), "utf8");

	it("finds an example block under the heading", () => {
		const lines = exampleLines(markdown);
		expect(lines.length).toBeGreaterThanOrEqual(10);
		expect(lines.every((line) => line.startsWith("Vayu "))).toBe(true);
	});

	it("prints each formatter's output, line for line", () => {
		expect(exampleLines(markdown)).toEqual(pinTimes(FORMATTED));
	});

	it("prints every run's start time through the formatter the swap above replaces", () => {
		const text = FORMATTED.join("\n");
		for (const start of STARTS) expect(text).toContain(formatInstant(start, "datetime"));
	});

	it("leaves the fixture URL's query off the page", () => {
		expect(exampleLines(markdown).join("\n")).not.toContain("token=abc");
	});
});

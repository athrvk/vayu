/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tool-list-budget.test.ts
 * @brief Holds `tools/list` to a size budget, and to the shape that kept it
 *        there (#2441).
 *
 * Every session pays for the whole list before it does anything, and an
 * agent's context is the scarce resource: the list had grown to 137 KB with
 * writes off and 212 KB with them on, with the same withholding,
 * default-header and error-definition sentences repeated in up to eleven
 * descriptions each. Those rules now live once, in the server instructions,
 * and a tool carries a one-line pointer (`withheldPointer`), none when reveal
 * is on. Nothing else re-checked the total, so a description that grows back
 * a paragraph would ship unnoticed.
 *
 * The caps are the measured size of the real registry through the real server
 * (app host) plus about 5%: 115,370 / 112,644 B with writes off (reveal off /
 * on) and 181,447 / 177,050 B with writes on. Before the fix, at d6c093c
 * (reveal off): 136,705 B with writes off, 211,549 B with writes on.
 * #2562's OAuth parameter lists then took the writes-off rows to 121,210 /
 * 118,484 B, and those two caps were re-set to that plus 5% (127,300 /
 * 124,500); the writes-on rows still fit their original caps.
 *
 * #2540's `dataFileCastNumbers` sentence in `list_runs`, with the descriptions
 * master gained meanwhile, took the writes-on rows to 190,876 B (reveal off)
 * and 186,479 B (reveal on), and their caps went from 186,000 / 190,600 to
 * 191,000 / 186,800 (one measurement plus a few hundred bytes). The
 * descriptions #2629, #2632 and #2640 then added took the reveal-off row to
 * 191,138 B on master itself, and its cap went to 191,500. #2396's
 * `targetRps` / `mode` sentences (a rate is `constant_rps`'s alone, and a
 * rate with no mode selects it) took the reveal-on row to 186,929 B, and its
 * cap went to 187,200.
 *
 * #2445's paged-read envelope schema on the five paged reads added about
 * 2,930 B to every row: 124,128 / 121,402 B writes off and 191,494 / 187,097 B
 * writes on became 127,059 / 124,333 and 194,425 / 190,028, and the caps went
 * to 128,500 / 125,800 and 196,000 / 191,600 (about 1% above each). The loose
 * schemas on the 23 other object-rooted reads (the rest of #2445) added 7,866 B
 * to every row, about 340 B a tool: 134,925 / 132,199 B writes off and
 * 202,291 / 197,894 B writes on, and the caps went to 136,300 / 133,600 and
 * 204,400 / 199,900 (about 1% above each).
 * The write-gate task wording adds to the instructions, not to `tools/list`,
 * so it spends none of this budget. #2444's `get_safety_config` (a description
 * and a small output schema, about 370 B a row) took the rows to 136,673 /
 * 133,947 B writes off and 204,039 / 199,642 B writes on; the writes-off caps
 * went to 137,100 / 134,400 and the writes-on caps still hold. #2451's paged
 * `run_collection_smoke` and the descriptions merged beside it then measured
 * 137,599 / 134,873 B writes off and 204,965 / 200,568 B writes on, and the
 * caps went to 137,900 / 135,200 and 205,300 / 200,900.
 *
 * #2895's `summary.partial` / `summary.summaryMissing` sentence in
 * `get_run_report` and the two keys in its output schema took the rows to
 * 143,949 / 141,223 B writes off and 211,863 / 207,466 B writes on; the caps
 * went to 144,300 / 141,600 and 212,200 / 207,800 (one measurement plus a few
 * hundred bytes).
 *
 * #2443 (the paged whole-list reads) added the envelope schema and the `q` /
 * `limit` / `offset` / `fields` arguments to four tools; the caps sit about 1%
 * above that measurement.
 *
 * #2892's sentence naming the assertion budget's two populations sits in the
 * `thresholds` argument, which `run_collection` and `start_load_run` share, so
 * it is paid twice (188 B each). It took the three rows that were within a few
 * hundred bytes of their caps to 143,732 / 141,006 / 207,249 B (writes off:
 * reveal off / on; writes on: reveal on), and those caps went to 143,900 /
 * 141,200 / 207,500.
 *
 * #2820's `assertionsPassed` / `assertionsFailed` sentence in `list_runs` is
 * paid once per row, 290 B. With the descriptions master gained meanwhile the
 * rows measure 144,608 / 141,882 / 212,522 / 208,125 B (writes off: reveal off
 * / on; writes on: reveal off / on), and the four caps went to 144,900 /
 * 142,200 / 212,800 / 208,400.
 *
 * #2930's `capacity` sentence in `list_runs` is paid once per row, 233 B. The
 * rows measure 144,811 / 142,085 / 212,725 / 208,328 B, 72 to 115 B under the
 * caps above, and the four caps went to 145,100 / 142,400 / 213,000 / 208,600.
 *
 * #2937's `timeout` argument, shared by `create_request` and `update_request`
 * (about 300 B a row, paid twice), and the reworded timeout sentence in
 * `start_load_run` took the writes-on rows to 213,439 / 209,042 B; the writes-on
 * caps went to 213,700 / 209,300 and the writes-off rows are untouched.
 *
 * #2823's `scenario` sentence and #2928's `capacity` sentence in
 * `get_live_metrics`, each paid once per row and each within the margin alone,
 * together took the rows to 145,407 / 142,681 / 213,909 / 209,512 B, and the
 * four caps went to 145,700 / 143,000 / 214,200 / 209,800.
 *
 * #2938's sentence in `get_run_report` (`latency` is absent, not zero, on a
 * crash-reconciled run) and its schema change landed beside #2937 on master,
 * and each passed alone. Together the rows measure 145,176 / 142,450 / 213,678
 * / 209,281 B (writes off: reveal off / on; writes on: reveal off / on), the
 * first two over their caps and the last two within 22 B of theirs; the four
 * caps went to 145,500 / 142,800 / 214,000 / 209,600 (one measurement plus a
 * few hundred bytes). With #2823's, #2928's and #2938's sentences all in, the
 * rows measure 145,407 / 142,681 / 213,909 / 209,512 B and the caps stay at
 * 145,700 / 143,000 / 214,200 / 209,800.
 *
 * #2955's `get_live_metrics` answer, now `{ticks, completed}` (one description
 * sentence and an `outputSchema`, paid once), took the rows to 145,857 /
 * 143,131 / 214,359 / 209,962 B, and the four caps went to 146,200 / 143,500 /
 * 214,700 / 210,300.
 *
 * #2446's renamed `entryId` / `itemId` arguments and their deprecated `id`
 * aliases (three write tools) took the writes-on rows to 214,955 / 210,558 B;
 * those two caps went to 215,300 / 210,900 and the writes-off rows are
 * untouched. #2962 removed the aliases again; the caps only bound growth and
 * stay where they were.
 *
 * #2446's `offset` and `pagination` envelope on `get_mock_activity` (its output
 * schema was a bare `{data}` list) and the `limit` ceiling on
 * `get_live_metrics` took all four rows up by about 800 B: 146,936 / 144,210 /
 * 215,751 / 211,354 B. The caps went to 147,200 / 144,500 / 216,100 / 211,700.
 *
 * #2971's Trash wording (a saved example is a fourth kind `list_trash` lists
 * and `restore_trash_entry` / `purge_trash_entry` act on, and
 * `delete_request_example` says where it goes) took the writes-on rows to
 * 216,547 / 212,150 B. Those two caps went to 216,800 / 212,400; `list_trash`
 * is the one read tool it touched and stays within the writes-off margin, so
 * those caps are untouched.
 *
 * #2973's client-certificate Trash kind (the same three trash tools name it, and
 * `list_trash` and `list_client_certificates` each gained a sentence) took the
 * rows to 147,481 / 144,755 / 217,136 / 212,739 B, and the four caps went to
 * 147,600 / 144,900 / 217,300 / 212,900.
 *
 * #3031's `declined` bucket (a sentence each in `diff_spec` and `sync_spec`, and
 * the key in `diff_spec`'s output schema) took the rows to 147,636 / 144,910 /
 * 217,409 / 213,012 B, and the four caps went to 147,900 / 145,200 / 217,700 /
 * 213,300.
 *
 * #3159's `bodyEncoding` sentence in `get_run_samples` is paid once per row. The
 * rows measure 147,998 / 145,272 / 217,760 / 213,363 B, and the four caps went
 * to 148,300 / 145,600 / 218,100 / 213,700.
 *
 * #3127's two `get_run_report` sentences (an inline script element row's
 * `messages` / `console`, and the sampled-replay `failures` with their
 * `failureCounts`), each paid once, added 256 B to every row (measured on the
 * tree before #3159 landed, so the rows after both are 148,254 / 145,528 /
 * 218,016 / 213,619 B), and the four caps went to 148,400 / 145,700 / 218,200 /
 * 213,800.
 */

import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { resolveSafetyConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { TOOLS, isListed } from "./tools.js";
import type { EngineClient } from "./engine-client.js";

interface Budget {
	allowWrites: boolean;
	revealSecretsToAgents: boolean;
	/** The tools a session under this config lists; a literal, so an empty registry cannot pass. */
	tools: number;
	/** Serialized `tools/list` bytes this config must stay under. */
	maxBytes: number;
}

const BUDGETS: Budget[] = [
	{ allowWrites: false, revealSecretsToAgents: false, tools: 52, maxBytes: 148_400 },
	{ allowWrites: false, revealSecretsToAgents: true, tools: 52, maxBytes: 145_700 },
	{ allowWrites: true, revealSecretsToAgents: false, tools: 80, maxBytes: 218_200 },
	{ allowWrites: true, revealSecretsToAgents: true, tools: 80, maxBytes: 213_800 },
];

/** A sentence this long, repeated across tools, is a rule that belongs in the instructions. */
const LONG_SENTENCE_CHARS = 150;
const MAX_TOOLS_PER_LONG_SENTENCE = 3;

/** `tools/list` as an app-host session under @p safety answers it. */
async function listTools(safety: Pick<Budget, "allowWrites" | "revealSecretsToAgents">) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const config = resolveSafetyConfig(safety);
	const server = createMcpServer({ name: "vayu", version: "test" }, () => ({
		client: {} as EngineClient,
		config,
		host: "app",
	}));
	await server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(clientTransport);
	const { tools, nextCursor } = await client.listTools();
	await server.close();
	// One page is the whole list only while no cursor is returned.
	expect(nextCursor).toBeUndefined();
	return { tools, config };
}

/** Each sentence of 150+ characters with the names of the tools whose description holds it. */
function longSentenceUsers(descriptions: [string, string][]): Map<string, string[]> {
	const users = new Map<string, string[]>();
	for (const [name, text] of descriptions) {
		const sentences = new Set(
			text.split(". ").filter((sentence) => sentence.length >= LONG_SENTENCE_CHARS)
		);
		for (const sentence of sentences)
			users.set(sentence, [...(users.get(sentence) ?? []), name]);
	}
	return users;
}

describe.each(BUDGETS)(
	"tools/list size budget, writes $allowWrites, reveal $revealSecretsToAgents",
	(budget) => {
		it("lists the tools the registry declares for the session", async () => {
			const { tools, config } = await listTools(budget);
			const declared = TOOLS.filter((tool) => isListed(tool, config)).map(
				(tool) => tool.name
			);
			expect(budget.tools).toBeGreaterThan(0);
			expect(tools.map((tool) => tool.name)).toEqual(declared);
			expect(tools.length).toBe(budget.tools);
		});

		it("stays under the byte budget", async () => {
			const { tools } = await listTools(budget);
			const bytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
			expect(bytes).toBeGreaterThan(0);
			expect(bytes).toBeLessThan(budget.maxBytes);
		});

		it(`repeats no ${LONG_SENTENCE_CHARS}+ character sentence in more than ${MAX_TOOLS_PER_LONG_SENTENCE} descriptions`, async () => {
			const { tools } = await listTools(budget);
			const descriptions = tools.map((tool): [string, string] => [
				tool.name,
				tool.description ?? "",
			]);
			// A scan over empty descriptions would pass forever.
			expect(descriptions.filter(([, text]) => text.length > 0).length).toBe(budget.tools);

			const repeated = [...longSentenceUsers(descriptions)]
				.filter(([, names]) => names.length > MAX_TOOLS_PER_LONG_SENTENCE)
				.map(
					([sentence, names]) =>
						`${names.length} tools (${names.join(", ")}): ${sentence}`
				);
			expect(repeated).toEqual([]);
		});
	}
);

describe("tools/list while reveal is on", () => {
	it.each([false, true])("carries no withholding wording, writes %s", async (allowWrites) => {
		const { tools } = await listTools({ allowWrites, revealSecretsToAgents: true });
		expect(tools.length).toBeGreaterThan(0);
		const offenders = tools
			.filter((tool) => /Withheld|<redacted>/.test(tool.description ?? ""))
			.map((tool) => tool.name);
		expect(offenders).toEqual([]);
	});
});

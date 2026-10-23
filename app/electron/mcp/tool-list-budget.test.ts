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
 * went to 137,100 / 134,400 and the writes-on caps still hold.
 *
 * Master had since drifted past every cap (137,599 / 134,873 B writes off,
 * 204,965 / 200,568 B writes on). #2443's paged whole-list reads then gave
 * `list_collections` and `list_requests` the envelope schema, the four lists
 * their `q` / `limit` / `offset` (and `fields`) arguments, and the descriptions
 * their page and summary sentences, about 4,590 B a row: 142,190 / 139,464 B
 * writes off and 209,556 / 205,159 B writes on, under caps of 143,600 /
 * 140,900 and 211,700 / 207,200 (about 1% above each).
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
	{ allowWrites: false, revealSecretsToAgents: false, tools: 52, maxBytes: 143_600 },
	{ allowWrites: false, revealSecretsToAgents: true, tools: 52, maxBytes: 140_900 },
	{ allowWrites: true, revealSecretsToAgents: false, tools: 80, maxBytes: 211_700 },
	{ allowWrites: true, revealSecretsToAgents: true, tools: 80, maxBytes: 207_200 },
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

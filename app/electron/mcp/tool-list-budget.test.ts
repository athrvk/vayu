/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tool-list-budget.test.ts
 * @brief Holds `tools/list` to a size budget, and to the shape that keeps it
 *        there (#2441, #3747).
 *
 * Every session pays for the whole list before it does anything, and an
 * agent's context is the scarce resource. Each cap is the measured size of the
 * real registry through the real server, for one host (the remedy wording
 * differs between the app and the stdio CLI) and one writes/reveal pair,
 * rounded up to the next 100 B. A change that grows the list re-measures and
 * moves the caps in its own diff; one that shrinks it lowers them.
 *
 * Two shapes keep the list small, and both are checked here. A rule that tool
 * descriptions would repeat lives once in the server instructions, and a tool
 * carries a one-line pointer. A long argument description is stated on one
 * argument and every other argument sharing it points there (`asOn`), unless
 * `SHARED_ARGUMENT_DESCRIPTIONS` names it with the reason.
 */

import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { resolveSafetyConfig } from "./config.js";
import { createMcpServer, stripDefaultSchemaDialect } from "./server.js";
import type { McpHost } from "./tools/contract.js";
import { TOOLS, isListed } from "./tools.js";
import { environmentIdInput } from "./tools/input-schemas.js";
import type { EngineClient } from "./engine-client.js";

interface Budget {
	host: McpHost;
	allowWrites: boolean;
	revealSecretsToAgents: boolean;
	/** The tools a session under this config lists; a literal, so an empty registry cannot pass. */
	tools: number;
	/** Serialized `tools/list` bytes this config must stay under. */
	maxBytes: number;
}

type Session = Pick<Budget, "host" | "allowWrites" | "revealSecretsToAgents">;

const BUDGETS: Budget[] = [
	{ host: "app", allowWrites: false, revealSecretsToAgents: false, tools: 56, maxBytes: 154_300 },
	{ host: "app", allowWrites: false, revealSecretsToAgents: true, tools: 56, maxBytes: 151_400 },
	{ host: "app", allowWrites: true, revealSecretsToAgents: false, tools: 84, maxBytes: 221_400 },
	{ host: "app", allowWrites: true, revealSecretsToAgents: true, tools: 84, maxBytes: 216_700 },
	{ host: "cli", allowWrites: false, revealSecretsToAgents: false, tools: 56, maxBytes: 154_600 },
	{ host: "cli", allowWrites: false, revealSecretsToAgents: true, tools: 56, maxBytes: 151_600 },
	{ host: "cli", allowWrites: true, revealSecretsToAgents: false, tools: 84, maxBytes: 223_200 },
	{ host: "cli", allowWrites: true, revealSecretsToAgents: true, tools: 84, maxBytes: 218_500 },
];

const HOSTS: McpHost[] = ["app", "cli"];
const WRITES_AND_REVEAL = [
	[false, false],
	[false, true],
	[true, false],
	[true, true],
] as const;

/** A sentence this long, repeated across tools, is a rule that belongs in the instructions. */
const LONG_SENTENCE_CHARS = 150;
const MAX_TOOLS_PER_LONG_SENTENCE = 3;

/** An argument description this long is stated on one argument; the others point at it. */
const LONG_ARGUMENT_CHARS = 80;

/** Argument descriptions repeated on purpose, each with the reason it is. */
const SHARED_ARGUMENT_DESCRIPTIONS = new Map<string, string>([
	[
		environmentIdInput.description ?? "",
		"#2480: every tool that takes environmentId states the one default at the argument, so a preview and a send cannot come to describe different ones (tools.test.ts pins it)",
	],
]);

/** What a pointer description names: the tool whose same-named argument says it in full. */
const POINTER = /^As on `(\w+)`/;

/** `tools/list` as a session on @p session's host and safety config answers it. */
async function listTools({ host, ...safety }: Session) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const config = resolveSafetyConfig(safety);
	const server = createMcpServer({ name: "vayu", version: "test" }, () => ({
		client: {} as EngineClient,
		config,
		host,
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

type ListedTool = Awaited<ReturnType<typeof listTools>>["tools"][number];

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

/** One description inside a tool's input or output schema. */
interface ArgumentDescription {
	/** `tool:in.path` or `tool:out.path`; `[]` steps into an item, `{}` into a record value. */
	where: string;
	/** The last property name on the path: the argument or member the text describes. */
	member: string;
	tool: string;
	text: string;
	/** The keywords the walk descended through to reach it. */
	via: Set<string>;
}

const BRANCH_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

const isSchema = (node: unknown): node is Record<string, unknown> =>
	typeof node === "object" && node !== null && !Array.isArray(node);

/** Every description in @p node and the schemas nested under it, appended to @p out. */
function collectDescriptions(
	node: unknown,
	at: Omit<ArgumentDescription, "text">,
	out: ArgumentDescription[]
): void {
	if (!isSchema(node)) return;
	if (typeof node.description === "string") out.push({ ...at, text: node.description });
	const into = (child: unknown, step: string, member: string, keyword: string) =>
		collectDescriptions(
			child,
			{ ...at, where: at.where + step, member, via: new Set([...at.via, keyword]) },
			out
		);
	if (isSchema(node.properties))
		for (const [name, child] of Object.entries(node.properties))
			into(child, `.${name}`, name, "properties");
	into(node.items, "[]", at.member, "items");
	into(node.additionalProperties, "{}", at.member, "additionalProperties");
	for (const keyword of BRANCH_KEYWORDS) {
		const branches = node[keyword];
		if (Array.isArray(branches))
			for (const branch of branches) into(branch, "", at.member, keyword);
	}
}

/** Every argument and output-member description @p tool carries. */
function argumentDescriptions(tool: ListedTool): ArgumentDescription[] {
	const out: ArgumentDescription[] = [];
	const root = (side: string) => ({
		where: `${tool.name}:${side}`,
		member: "",
		tool: tool.name,
		via: new Set<string>(),
	});
	collectDescriptions(tool.inputSchema, root("in"), out);
	collectDescriptions(tool.outputSchema, root("out"), out);
	return out;
}

describe.each(BUDGETS)(
	"tools/list size budget, host $host, writes $allowWrites, reveal $revealSecretsToAgents",
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

		it(`states each ${LONG_ARGUMENT_CHARS}+ character argument description on one argument`, async () => {
			const { tools } = await listTools(budget);
			const descriptions = tools.flatMap(argumentDescriptions);
			// A walk that found nothing would pass forever.
			expect(descriptions.length).toBeGreaterThan(0);

			const holders = new Map<string, string[]>();
			for (const { where, text } of descriptions) {
				if (text.length < LONG_ARGUMENT_CHARS || SHARED_ARGUMENT_DESCRIPTIONS.has(text))
					continue;
				holders.set(text, [...(holders.get(text) ?? []), where]);
			}
			const repeated = [...holders]
				.filter(([, where]) => where.length > 1)
				.map(([text, where]) => `${where.length} arguments (${where.join(", ")}): ${text}`);
			expect(repeated).toEqual([]);
		});

		it("points every `As on` description at a listed tool stating that member", async () => {
			const { tools } = await listTools(budget);
			const descriptions = tools.flatMap(argumentDescriptions);
			const pointers = descriptions.filter(({ text }) => POINTER.test(text));
			expect(pointers.length).toBeGreaterThan(0);

			const stated = new Set(
				descriptions
					.filter(({ text }) => !POINTER.test(text))
					.map(({ tool, member }) => `${tool}:${member}`)
			);
			const dangling = pointers
				.filter(({ text, member }) => !stated.has(`${POINTER.exec(text)?.[1]}:${member}`))
				.map(({ where, text }) => `${where}: ${text}`);
			expect(dangling).toEqual([]);
		});
	}
);

describe("tools/list budgets", () => {
	it("hold a row for every host and writes/reveal pair", () => {
		const key = ({ host, allowWrites, revealSecretsToAgents }: Session) =>
			`${host} ${allowWrites} ${revealSecretsToAgents}`;
		const expected = HOSTS.flatMap((host) =>
			WRITES_AND_REVEAL.map(([allowWrites, revealSecretsToAgents]) =>
				key({ host, allowWrites, revealSecretsToAgents })
			)
		);
		expect(BUDGETS.map(key).sort()).toEqual(expected.sort());
	});

	// The CLI's remedy wording is longer than the app's, so measuring the app
	// twice would pass every CLI cap; the two lists have to differ.
	it.each(WRITES_AND_REVEAL)(
		"measure the cli host's own wording, writes %s, reveal %s",
		async (allowWrites, revealSecretsToAgents) => {
			const serialized = async (host: McpHost) =>
				JSON.stringify(
					(await listTools({ host, allowWrites, revealSecretsToAgents })).tools
				);
			expect(await serialized("cli")).not.toBe(await serialized("app"));
		}
	);

	// The argument scan checks a fraction of the list if the walk stops at the
	// top level; each keyword it descends through reaches a description.
	it.each(["properties", "items", "anyOf", "additionalProperties"])(
		"walk argument schemas through %s",
		async (keyword) => {
			const { tools } = await listTools({
				host: "app",
				allowWrites: true,
				revealSecretsToAgents: false,
			});
			const reached = tools
				.flatMap(argumentDescriptions)
				.filter(({ via }) => via.has(keyword));
			expect(reached.length).toBeGreaterThan(0);
		}
	);
});

describe("tools/list while reveal is on", () => {
	it.each([false, true])("carries no withholding wording, writes %s", async (allowWrites) => {
		const { tools } = await listTools({
			host: "app",
			allowWrites,
			revealSecretsToAgents: true,
		});
		expect(tools.length).toBeGreaterThan(0);
		const offenders = tools
			.filter((tool) => /Withheld|<redacted>/.test(tool.description ?? ""))
			.map((tool) => tool.name);
		expect(offenders).toEqual([]);
	});
});

describe("tools/list schema dialect (#3748)", () => {
	const DIALECT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

	describe.each<McpHost>(["app", "cli"])("on the %s host", (host) => {
		it.each([false, true])(
			"names no dialect on any tool schema, writes %s",
			async (allowWrites) => {
				const { tools } = await listTools({
					host,
					allowWrites,
					revealSecretsToAgents: false,
				});
				const schemas = tools.flatMap((tool) =>
					[tool.inputSchema, tool.outputSchema].filter((schema) => schema !== undefined)
				);
				// A scan over no schemas would pass forever; every tool has an input schema.
				expect(schemas.length).toBeGreaterThan(tools.length);
				expect(schemas.filter((schema) => "$schema" in schema)).toEqual([]);
			}
		);
	});

	describe("stripDefaultSchemaDialect", () => {
		const otherDialect = "http://json-schema.org/draft-07/schema#";

		it("drops the 2020-12 key from input and output schemas, and only that key", () => {
			const out = stripDefaultSchemaDialect({
				tools: [
					{
						name: "t",
						inputSchema: { $schema: DIALECT_2020_12, type: "object" },
						outputSchema: { $schema: DIALECT_2020_12, type: "object" },
					},
				],
			});
			expect(out).toEqual({
				tools: [
					{
						name: "t",
						inputSchema: { type: "object" },
						outputSchema: { type: "object" },
					},
				],
			});
		});

		it("keeps a schema that declares another dialect", () => {
			const tool = {
				name: "t",
				inputSchema: { $schema: otherDialect, type: "object" },
				outputSchema: { $schema: DIALECT_2020_12, type: "object" },
			};
			const [out] = stripDefaultSchemaDialect({ tools: [tool] }).tools;
			expect(out.inputSchema).toEqual({ $schema: otherDialect, type: "object" });
			expect(out.outputSchema).toEqual({ type: "object" });
		});

		it("accepts a tool without an outputSchema, and an answer without tools", () => {
			const [out] = stripDefaultSchemaDialect({
				tools: [{ name: "t", inputSchema: { $schema: DIALECT_2020_12 } }],
			}).tools;
			expect(out).toEqual({ name: "t", inputSchema: {} });
			expect("outputSchema" in out).toBe(false);
			expect(stripDefaultSchemaDialect({ nextCursor: "c" })).toEqual({ nextCursor: "c" });
		});

		it("leaves a property named $schema alone", () => {
			const inputSchema = {
				$schema: DIALECT_2020_12,
				properties: { $schema: { $schema: DIALECT_2020_12, type: "string" } },
			};
			const [out] = stripDefaultSchemaDialect({ tools: [{ name: "t", inputSchema }] }).tools;
			expect(out.inputSchema).toEqual({
				properties: { $schema: { $schema: DIALECT_2020_12, type: "string" } },
			});
		});

		it("does not mutate its input", () => {
			const answer = {
				tools: [{ name: "t", inputSchema: { $schema: DIALECT_2020_12, type: "object" } }],
			};
			const before = structuredClone(answer);
			stripDefaultSchemaDialect(answer);
			expect(answer).toEqual(before);
		});
	});
});

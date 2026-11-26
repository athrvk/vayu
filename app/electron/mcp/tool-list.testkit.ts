/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tool-list.testkit.ts
 * @brief What the `tools/list` test files share: the session matrix, one
 *        session's answer through the real server, and the walk over the
 *        descriptions inside a tool's schemas.
 */

import { expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { resolveSafetyConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import type { McpHost } from "./tools/contract.js";
import type { EngineClient } from "./engine-client.js";

/** One session's host and the safety settings that decide what it lists. */
export interface Session {
	host: McpHost;
	allowWrites: boolean;
	revealSecretsToAgents: boolean;
}

export const HOSTS: McpHost[] = ["app", "cli"];

export const WRITES_AND_REVEAL = [
	[false, false],
	[false, true],
	[true, false],
	[true, true],
] as const;

/** Every host under every writes/reveal pair; the remedy wording differs per host. */
export const SESSIONS: Session[] = HOSTS.flatMap((host) =>
	WRITES_AND_REVEAL.map(([allowWrites, revealSecretsToAgents]) => ({
		host,
		allowWrites,
		revealSecretsToAgents,
	}))
);

/**
 * The fewest tools any session lists. A fixed floor, not a count that follows
 * the registry: a scan over an empty list would pass forever.
 */
export const MIN_LISTED_TOOLS = 20;

/** `tools/list` and the server instructions as a session answers them. */
export async function listTools({ host, ...safety }: Session) {
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
	const instructions = client.getInstructions() ?? "";
	await server.close();
	// One page is the whole list only while no cursor is returned.
	expect(nextCursor).toBeUndefined();
	return { tools, config, instructions };
}

export type ListedTool = Awaited<ReturnType<typeof listTools>>["tools"][number];

/** One description inside a tool's input or output schema. */
export interface ArgumentDescription {
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
export function argumentDescriptions(tool: ListedTool): ArgumentDescription[] {
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

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keeps the two copies of the MCP data-entity list honest.
 *
 * The main process owns `MCP_DATA_ENTITIES`; the renderer needs the same union
 * to type the IPC payload and its invalidation map, and production code under
 * `electron/` cannot import from `app/src` (the reasoning is in
 * `tsconfig.node.json`). So the type is written twice on purpose - and a
 * divergence would be silent in the worst possible way: the main process would
 * emit a family the renderer's map has no entry for, and the write would stay
 * invisible, which is the bug the channel exists to fix.
 *
 * This file is the one place the two meet. It reaches across the boundary the
 * way `tools.test.ts` already reaches for `@/constants/load-test`.
 */

import { describe, expect, test } from "vitest";
import { MCP_DATA_ENTITIES, type McpDataChangedEvent as MainEvent } from "./tools.js";
import type { McpDataEntity, McpDataChangedEvent as RendererEvent } from "@/types/domain";

/*
 * Exhaustive by construction: TypeScript rejects this literal if the renderer's
 * union gains a member that is not listed, and rejects a listed member the
 * union does not have. The runtime comparison below catches the other
 * direction - the main process gaining an entity the renderer never heard of.
 */
const RENDERER_ENTITIES: Record<McpDataEntity, true> = {
	collection: true,
	request: true,
	environment: true,
	run: true,
	cookie: true,
	config: true,
	service: true,
	oauth: true,
};

describe("McpDataEntity mirror", () => {
	test("the main process and the renderer name the same entities", () => {
		expect([...MCP_DATA_ENTITIES].sort()).toEqual(Object.keys(RENDERER_ENTITIES).sort());
	});

	test("the list it scanned is not empty", () => {
		// A comparison of two empty lists passes while proving nothing - the
		// failure mode CLAUDE.md records for source-scanning guards.
		expect(MCP_DATA_ENTITIES.length).toBeGreaterThan(0);
	});
});

/*
 * The entity union is not the only thing written twice: the event carrying it
 * is too, scope hints and all. A hint added on the emitting side and forgotten
 * on the reading side is the same silent failure - the main process would send
 * a narrowing the renderer's invalidator never reads.
 *
 * Mutual assignability alone would not see it (an extra optional property is
 * still assignable both ways), so the property *names* are compared as well.
 * The check is the compiler's - `pnpm type-check` is where it fails; the
 * assertions below exist so the constants are read rather than left as dead
 * declarations lint would strip.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const EVENT_TYPES_MATCH: Exact<MainEvent, RendererEvent> = true;
const EVENT_KEYS_MATCH: Exact<keyof MainEvent, keyof RendererEvent> = true;

describe("McpDataChangedEvent mirror", () => {
	test("both sides describe the same event, with the same scope hints", () => {
		expect(EVENT_TYPES_MATCH).toBe(true);
		expect(EVENT_KEYS_MATCH).toBe(true);
	});
});

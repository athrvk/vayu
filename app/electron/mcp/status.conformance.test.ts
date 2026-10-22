/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keeps the two copies of the `mcp:status` and `mcp:connectClient` shapes honest.
 *
 * The main process builds them (`status.ts`, `connect.ts`); the renderer types
 * what it receives in `src/types/domain.ts`. Production code under `electron/`
 * cannot import from `app/src` (see `tsconfig.node.json`), so each shape is
 * written twice on purpose. A drift would be silent at runtime - a reason or an
 * error code one side never heard of - so the check is the compiler's: `pnpm
 * type-check` fails here. The assertions only keep the constants read.
 */

import { describe, expect, test } from "vitest";
import type { McpConnectResult as MainConnectResult } from "./connect.js";
import type { McpStartError as MainStartError, McpStatus as MainStatus } from "./status.js";
import type {
	McpConnectResult as RendererConnectResult,
	McpStartError as RendererStartError,
	McpStatus as RendererStatus,
} from "@/types/domain";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const STATUS_MATCHES: Exact<MainStatus, RendererStatus> = true;
const START_ERROR_MATCHES: Exact<MainStartError, RendererStartError> = true;
const CONNECT_RESULT_MATCHES: Exact<MainConnectResult, RendererConnectResult> = true;
const CONNECT_REASONS_MATCH: Exact<
	NonNullable<MainConnectResult["reason"]>,
	NonNullable<RendererConnectResult["reason"]>
> = true;

describe("mcp status mirror", () => {
	test("the main process and the renderer describe the same shapes", () => {
		expect(STATUS_MATCHES).toBe(true);
		expect(START_ERROR_MATCHES).toBe(true);
		expect(CONNECT_RESULT_MATCHES).toBe(true);
		expect(CONNECT_REASONS_MATCH).toBe(true);
	});
});

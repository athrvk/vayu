/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { SERVER_ICON_SOURCE, SERVER_ICONS } from "./server-icon";

describe("the MCP server icon", () => {
	it("is the bytes of the shared icon it names", () => {
		const source = readFileSync(fromRepoRoot(SERVER_ICON_SOURCE));
		expect(source.length).toBeGreaterThan(0);
		const [icon] = SERVER_ICONS;
		expect(icon.src).toBe(`data:image/png;base64,${source.toString("base64")}`);
	});
});

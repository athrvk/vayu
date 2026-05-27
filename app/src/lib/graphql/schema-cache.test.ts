/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSchema } from "graphql";

vi.mock("./introspect", () => ({ introspectSchema: vi.fn() }));
import { introspectSchema } from "./introspect";
import { useSchemaCache } from "./schema-cache";

const schema = buildSchema("type Query { ping: String }");
const URL = "https://api.test/gql";

beforeEach(() => {
	vi.clearAllMocks();
	useSchemaCache.setState({ byUrl: {}, activeUrl: null });
});

describe("schema cache", () => {
	it("transitions idle → loading → ready on success", async () => {
		(introspectSchema as any).mockResolvedValue(schema);
		const p = useSchemaCache.getState().ensureSchema(URL, {});
		expect(useSchemaCache.getState().byUrl[URL].status).toBe("loading");
		await p;
		expect(useSchemaCache.getState().byUrl[URL].status).toBe("ready");
		expect(useSchemaCache.getState().byUrl[URL].schema).toBe(schema);
	});

	it("transitions to error on failure", async () => {
		(introspectSchema as any).mockRejectedValue(new Error("blocked"));
		await useSchemaCache.getState().ensureSchema(URL, {});
		expect(useSchemaCache.getState().byUrl[URL].status).toBe("error");
		expect(useSchemaCache.getState().byUrl[URL].error).toMatch(/blocked/);
	});

	it("does not re-introspect a url already ready", async () => {
		(introspectSchema as any).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema(URL, {});
		await useSchemaCache.getState().ensureSchema(URL, {});
		expect(introspectSchema).toHaveBeenCalledTimes(1);
	});

	it("does not retry a url already in error (until url changes)", async () => {
		(introspectSchema as any).mockRejectedValue(new Error("blocked"));
		await useSchemaCache.getState().ensureSchema(URL, {});
		await useSchemaCache.getState().ensureSchema(URL, {});
		expect(introspectSchema).toHaveBeenCalledTimes(1);
	});

	it("refreshSchema re-introspects even when already ready", async () => {
		(introspectSchema as any).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema(URL, {});
		await useSchemaCache.getState().refreshSchema(URL, {});
		expect(introspectSchema).toHaveBeenCalledTimes(2);
		expect(useSchemaCache.getState().byUrl[URL].status).toBe("ready");
	});

	it("getActiveSchema follows activeUrl", async () => {
		(introspectSchema as any).mockResolvedValue(schema);
		await useSchemaCache.getState().ensureSchema(URL, {});
		expect(useSchemaCache.getState().getActiveSchema()).toBeNull();
		useSchemaCache.getState().setActiveUrl(URL);
		expect(useSchemaCache.getState().getActiveSchema()).toBe(schema);
		expect(useSchemaCache.getState().getActiveStatus()).toBe("ready");
	});
});

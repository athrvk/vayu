import { describe, it, expect, vi } from "vitest";
import { ImportOrchestrator, type ImportApi } from "./orchestrator";
import { assignIds } from "./assign-ids";
import type { ImportResult } from "./types";

function fakeApi(overrides: Partial<ImportApi> = {}): { api: ImportApi; calls: any } {
  const calls = { collections: [] as any[], requests: [] as any[], environments: [] as any[], deletedCols: [] as string[], deletedEnvs: [] as string[] };
  const api: ImportApi = {
    createCollection: vi.fn(async (d) => { calls.collections.push(d); return { id: d.id } as any; }),
    createRequest: vi.fn(async (d) => { calls.requests.push(d); return { id: d.id } as any; }),
    createEnvironment: vi.fn(async (d) => { calls.environments.push(d); return { id: d.id } as any; }),
    deleteCollection: vi.fn(async (id) => { calls.deletedCols.push(id); }),
    deleteEnvironment: vi.fn(async (id) => { calls.deletedEnvs.push(id); }),
    ...overrides,
  };
  return { api, calls };
}

function fixture(): ImportResult {
  return assignIds({
    collections: [{
      name: "root", description: "", variables: {}, auth: { mode: "none" }, preRequestScript: "", postRequestScript: "",
      requests: [{ name: "r1", description: "", method: "POST", url: "u", params: [], headers: [], body: { mode: "json", content: "{}" }, auth: { mode: "inherit" }, preRequestScript: "", postRequestScript: "" }],
      children: [{ name: "child", description: "", variables: {}, auth: { mode: "none" }, preRequestScript: "", postRequestScript: "",
        requests: [{ name: "r2", description: "", method: "GET", url: "u2", params: [], headers: [], body: { mode: "none" }, auth: { mode: "inherit" }, preRequestScript: "", postRequestScript: "" }], children: [] }],
    }],
    environments: [{ name: "Prod", description: "d", variables: { a: { value: "1", enabled: true } } }],
    meta: { format: "x", requestCount: 2, folderCount: 1, environmentCount: 1, skipped: [], nonExecutableAuth: 0 },
  });
}

const opts = { importEnvironments: true, importScripts: true };

describe("ImportOrchestrator", () => {
  it("creates parents before children before requests, with explicit order, bodyType, and parentId", async () => {
    const { api, calls } = fakeApi();
    await new ImportOrchestrator(api).run(fixture(), opts);

    expect(calls.collections[0].parentId).toBeUndefined();
    expect(calls.collections[0].order).toBe(0);
    expect(calls.collections[1].parentId).toBe(calls.collections[0].id);

    const r1 = calls.requests.find((r: any) => r.name === "r1");
    expect(r1.collectionId).toBe(calls.collections[0].id);
    expect(r1.bodyType).toBe("json");
    expect(typeof r1.order).toBe("number");
    expect(r1.auth).toEqual({ mode: "inherit" });

    expect(calls.environments[0].description).toBe("d");
    expect("isActive" in calls.environments[0]).toBe(false);
  });

  it("skips environments when importEnvironments=false", async () => {
    const { api, calls } = fakeApi();
    await new ImportOrchestrator(api).run(fixture(), { ...opts, importEnvironments: false });
    expect(calls.environments).toHaveLength(0);
  });

  it("rolls back created roots + envs when a create fails midway", async () => {
    const calls = { requests: [] as any[] };
    const { api, calls: c } = fakeApi({
      createRequest: vi.fn(async (d: any) => { if (d.name === "r2") throw new Error("boom"); calls.requests.push(d); return { id: d.id } as any; }),
    });
    await expect(new ImportOrchestrator(api).run(fixture(), opts)).rejects.toThrow("boom");
    expect(c.deletedCols).toHaveLength(1);
    expect(api.deleteCollection).toHaveBeenCalledWith(c.collections[0].id);
  });
});

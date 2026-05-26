import { describe, it, expect } from "vitest";
import { assignIds } from "./assign-ids";
import type { ImportResult } from "./types";

function fixture(): ImportResult {
  return {
    collections: [
      {
        name: "root", description: "", variables: {}, auth: { mode: "none" },
        preRequestScript: "", postRequestScript: "",
        requests: [{ name: "r", description: "", method: "GET", url: "", params: [], headers: [], body: { mode: "none" }, auth: { mode: "inherit" }, preRequestScript: "", postRequestScript: "" }],
        children: [{ name: "child", description: "", variables: {}, auth: { mode: "none" }, preRequestScript: "", postRequestScript: "", requests: [], children: [] }],
      },
    ],
    environments: [{ name: "e", description: "", variables: {} }],
    meta: { format: "x", requestCount: 1, folderCount: 1, environmentCount: 1, skipped: [], nonExecutableAuth: 0 },
  };
}

describe("assignIds", () => {
  it("assigns prefixed unique ids to every collection, request, and environment", () => {
    const r = assignIds(fixture());
    const root = r.collections[0];
    expect(root.id).toMatch(/^col_/);
    expect(root.children[0].id).toMatch(/^col_/);
    expect(root.requests[0].id).toMatch(/^req_/);
    expect(r.environments[0].id).toMatch(/^env_/);
    expect(root.id).not.toBe(root.children[0].id);
  });
});

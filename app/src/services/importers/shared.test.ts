import { describe, it, expect } from "vitest";
import { toVarRecord, mapPostmanAuth, rawBody, joinExec } from "./shared";

describe("toVarRecord", () => {
  it("builds a VariableValue record, stringifying values, defaulting enabled", () => {
    expect(toVarRecord([{ key: "a", value: 1 }, { key: "b", value: "x", disabled: true }])).toEqual({
      a: { value: "1", enabled: true },
      b: { value: "x", enabled: false },
    });
  });
});

describe("mapPostmanAuth", () => {
  it("maps v2.1 bearer array shape", () => {
    expect(mapPostmanAuth({ type: "bearer", bearer: [{ key: "token", value: "T" }] })).toEqual({
      mode: "bearer",
      token: "T",
    });
  });
  it("maps v2.0 bearer object shape", () => {
    expect(mapPostmanAuth({ type: "bearer", bearer: { token: "T" } })).toEqual({
      mode: "bearer",
      token: "T",
    });
  });
  it("maps apikey with in", () => {
    expect(
      mapPostmanAuth({ type: "apikey", apikey: [{ key: "key", value: "X" }, { key: "value", value: "V" }, { key: "in", value: "query" }] })
    ).toEqual({ mode: "apikey", key: "X", value: "V", in: "query" });
  });
  it("noauth → none", () => {
    expect(mapPostmanAuth({ type: "noauth" })).toEqual({ mode: "none" });
  });
  it("oauth2 stored as config", () => {
    const r = mapPostmanAuth({ type: "oauth2", oauth2: [{ key: "accessToken", value: "A" }] });
    expect(r.mode).toBe("oauth2");
  });
});

describe("rawBody", () => {
  it("json language → json mode", () => {
    expect(rawBody('{"a":1}', "json")).toEqual({ mode: "json", content: '{"a":1}' });
  });
  it("no language, valid JSON → json", () => {
    expect(rawBody('{"a":1}', undefined)).toEqual({ mode: "json", content: '{"a":1}' });
  });
  it("no language, non-JSON → text", () => {
    expect(rawBody("hello", undefined)).toEqual({ mode: "text", content: "hello" });
  });
});

describe("joinExec", () => {
  it("joins exec lines with newline", () => {
    expect(joinExec({ script: { exec: ["a", "b"] } })).toBe("a\nb");
  });
  it("missing → empty string", () => {
    expect(joinExec(undefined)).toBe("");
  });
});

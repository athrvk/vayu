import { describe, it, expect } from "vitest";
import { toVarRecord, mapPostmanAuth, rawBody, joinExec, asString, mapKeyValues } from "./shared";

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
    expect((r as any).config.accessToken).toBe("A");
  });
  it("unknown type → none", () => {
    expect(mapPostmanAuth({ type: "weird" })).toEqual({ mode: "none" });
  });
  it('inherit → {mode:"inherit"}', () => {
    expect(mapPostmanAuth({ type: "inherit" })).toEqual({ mode: "inherit" });
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

describe("asString", () => {
  it("coerces scalars and objects", () => {
    expect(asString(null)).toBe("");
    expect(asString(undefined)).toBe("");
    expect(asString("x")).toBe("x");
    expect(asString(5)).toBe("5");
    expect(asString(true)).toBe("true");
    expect(asString({ a: 1 })).toBe('{"a":1}');
    expect(asString([1, 2])).toBe("[1,2]");
  });
});

describe("mapKeyValues", () => {
  it("maps rows, preserves disabled + duplicates, drops blank keys, omits absent description", () => {
    expect(
      mapKeyValues([
        { key: "Accept", value: "application/json" },
        { key: "X", value: "1", disabled: true },
        { key: "Accept", value: "text/html" },
        { key: "", value: "ignored" },
        { key: "Trace", value: "on", description: "d" },
      ])
    ).toEqual([
      { key: "Accept", value: "application/json", enabled: true },
      { key: "X", value: "1", enabled: false },
      { key: "Accept", value: "text/html", enabled: true },
      { key: "Trace", value: "on", enabled: true, description: "d" },
    ]);
  });
});

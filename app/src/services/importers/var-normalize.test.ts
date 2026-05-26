import { describe, it, expect } from "vitest";
import { normalizeVars } from "./var-normalize";

describe("normalizeVars", () => {
  it("trims spaces inside Postman-style braces", () => {
    expect(normalizeVars("{{ baseUrl }}/x")).toBe("{{baseUrl}}/x");
  });
  it("strips the Insomnia _. prefix", () => {
    expect(normalizeVars("{{ _.baseUrl }}/users")).toBe("{{baseUrl}}/users");
  });
  it("converts OpenAPI single-brace path params", () => {
    expect(normalizeVars("/users/{userId}/posts/{postId}")).toBe(
      "/users/{{userId}}/posts/{{postId}}"
    );
  });
  it("leaves Nunjucks tags and filters verbatim", () => {
    expect(normalizeVars("{% uuid %}")).toBe("{% uuid %}");
    expect(normalizeVars("{{ name | lower }}")).toBe("{{ name | lower }}");
  });
  it("does not double-wrap already-correct vars", () => {
    expect(normalizeVars("{{baseUrl}}")).toBe("{{baseUrl}}");
  });
});

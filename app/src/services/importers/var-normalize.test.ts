import { describe, it, expect } from "vitest";
import { normalizeVars } from "./var-normalize";

describe("normalizeVars", () => {
	it("trims spaces inside Postman-style braces", () => {
		expect(normalizeVars("{{ baseUrl }}/x")).toBe("{{baseUrl}}/x");
	});
	it("strips the Insomnia _. prefix", () => {
		expect(normalizeVars("{{ _.baseUrl }}/users")).toBe("{{baseUrl}}/users");
	});
	it("converts OpenAPI single-brace path params when the caller asks for it", () => {
		expect(normalizeVars("/users/{userId}/posts/{postId}", { pathTemplates: true })).toBe(
			"/users/{{userId}}/posts/{{postId}}"
		);
	});
	it("leaves a single brace alone by default - it is literal text in Postman/Insomnia", () => {
		// `{beta}` is a valid literal path segment and `friends{name}` a real Graph
		// API query value. Rewriting either invents a variable that resolves to
		// nothing, so the rewrite is opt-in per format (issue #195, finding 7).
		expect(normalizeVars("https://api.example.com/tags/{beta}")).toBe(
			"https://api.example.com/tags/{beta}"
		);
		expect(normalizeVars("friends{name}")).toBe("friends{name}");
	});
	it("still normalizes double braces with pathTemplates on", () => {
		expect(normalizeVars("{{ _.baseUrl }}/x/{id}", { pathTemplates: true })).toBe(
			"{{baseUrl}}/x/{{id}}"
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

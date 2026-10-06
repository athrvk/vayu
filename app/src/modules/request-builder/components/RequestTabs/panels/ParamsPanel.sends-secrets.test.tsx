/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The "Sends" line hides a secret variable's value (#1806).
 *
 * The line is the resolved URL, so a `{{token}}` in the path or query would
 * otherwise sit on screen as plain text beside a variable the user marked secret
 * - a screenshot or a screen share leaks what the Variables page masks. A secret
 * also reaches the URL encoded, so the encoded spellings are masked too.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import ParamsPanel from "./ParamsPanel";

afterEach(cleanup);

const SECRET = "a b&c";
const VALUES: Record<string, string> = { token: SECRET, region: "eu-1", base: "https://x" };
const resolve = (s: string) => s.replace(/{{(\w+)}}/g, (_m, name: string) => VALUES[name] ?? "");

function sendsLine(url: string, overrides: Partial<RequestState> = {}): string {
	const value = {
		request: {
			...createDefaultRequestState(),
			id: `req_${url}`,
			url,
			params: [],
			...overrides,
		},
		updateField: () => {},
		resolveString: resolve,
		getAllVariables: () => ({
			token: { value: SECRET, scope: "environment", secret: true },
			region: { value: "eu-1", scope: "environment" },
		}),
		getVariableOrigins: () => [],
		updateVariable: () => {},
		writableScopes: [],
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
	const { container } = render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<ParamsPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
	const label = [...container.querySelectorAll("span")].find((el) => el.textContent === "Sends");
	return label?.nextElementSibling?.textContent ?? "";
}

describe("the Sends line's secrets", () => {
	it("masks a secret variable in the query, in its encoded form, and keeps a plain variable", () => {
		const line = sendsLine("{{base}}/s?q={{token}}&r={{region}}");
		expect(line).toBe("https://x/s?q=••••&r=eu-1");
		expect(line).not.toContain("%20");
	});

	it("masks a secret variable in a path segment, encoded or as written", () => {
		const encoded = sendsLine("{{base}}/:id/x", {
			params: [{ id: "p1", key: "id", value: "{{token}}", enabled: true, in: "path" }],
		});
		expect(encoded).toBe("https://x/••••/x");

		const raw = sendsLine("{{base}}/{{token}}/x", { disableUrlEncoding: true });
		expect(raw).toBe("https://x/••••/x");
	});

	it("masks the request's own auth credential wherever it lands in the URL", () => {
		const line = sendsLine("{{base}}/s?key=hunter2", {
			auth: { mode: "bearer", token: "hunter2" },
		});
		expect(line).toBe("https://x/s?key=••••");
	});

	it("leaves a URL with no secret as it resolves", () => {
		expect(sendsLine("{{base}}/s?r={{region}}")).toBe("https://x/s?r=eu-1");
	});
});

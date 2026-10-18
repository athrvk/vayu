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
 * The start form's helper lines name wire identifiers (`exp`, `/token`, ...).
 * JSX text is not Markdown, so a backtick there prints as a character; the
 * identifiers are `<code>` elements instead.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewIssuerDialog } from "./NewIssuerDialog";

function renderDialog() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<NewIssuerDialog onOpenChange={() => {}} />
		</QueryClientProvider>
	);
}

/** The helper `<span>` inside the label for a field, and the `<code>` text in it. */
function helperCodes(labelText: string): string[] {
	const label = screen.getByText(labelText, { selector: "label" });
	const helper = label.querySelector("span");
	if (!helper) throw new Error(`no helper line under the "${labelText}" label`);
	return Array.from(helper.querySelectorAll("code"), (code) => code.textContent ?? "");
}

beforeEach(() => {
	cleanup();
});

describe("NewIssuerDialog helper lines", () => {
	it("prints no literal backtick anywhere in the dialog", () => {
		renderDialog();
		const text = document.body.textContent ?? "";
		expect(text).toContain("Token lifetime");
		expect(text).not.toContain("`");
	});

	it("sets the token lifetime's identifiers in code", () => {
		renderDialog();
		expect(helperCodes("Token lifetime")).toEqual(["exp", "expires_in"]);
	});

	it("sets the failure mode's endpoint in code", () => {
		renderDialog();
		expect(helperCodes("Failure mode")).toEqual(["/token"]);
	});

	it("sets the reserved claims in code", () => {
		renderDialog();
		expect(helperCodes("Claims")).toEqual(["iss", "iat", "exp", "jti"]);
	});
});

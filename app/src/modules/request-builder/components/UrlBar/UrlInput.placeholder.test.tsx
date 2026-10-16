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
 * The empty URL bar says it takes a curl command (#2196).
 *
 * Pasting a command here is the app's only curl import, and the right-click
 * "Paste as curl" item is found only by someone who already thinks to look. A
 * Postman user opens Import for it, finds no curl, and concludes it is
 * unsupported - so the field itself is where it has to be advertised.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import { emptyDrafts } from "../../utils/body-drafts";
import UrlInput from "./UrlInput";

function renderUrlInput() {
	const context = {
		request: { ...createDefaultRequestState(), url: "" },
		setRequest: vi.fn(),
		updateField: vi.fn(),
		getBodyDrafts: () => emptyDrafts(null),
		setBodyDrafts: vi.fn(),
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: vi.fn(),
		writableScopes: [],
	} as unknown as RequestBuilderContextValue;

	render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={context}>
				<UrlInput />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

afterEach(cleanup);

describe("the URL bar's placeholder", () => {
	it("tells the user a curl command can be pasted", () => {
		renderUrlInput();
		// Found by its accessible name: the placeholder must not have displaced it.
		const input = screen.getByLabelText("Request URL");
		expect(input.getAttribute("placeholder") ?? "").toMatch(/curl command/i);
	});
});

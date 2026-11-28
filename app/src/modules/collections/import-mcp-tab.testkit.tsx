/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Import dialog's MCP server tab, rendered and driven, for the suites that test it
 * (`ImportModal.mcp*.test.tsx`). A suite still mocks `@/queries/import` itself: `vi.mock` is
 * hoisted per test file.
 */

import { vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@/test/render-with-tooltips";
import type { ImportMcpRequest } from "@/types";
import type { ImportResult } from "@/services/importers/types";
import { ImportModal } from "./ImportModal";
import { collection, request, result } from "./import-preview.testkit";

export const SERVER = "https://mcp.example.com/mcp";

/** What the engine builds for a server with one tool, as `POST /import/mcp` answers. */
export function serverTree(opts: { withToken?: boolean } = {}): ImportResult {
	return result({
		collections: [
			collection({
				name: "Acme tools",
				variables: opts.withToken
					? { mcpToken: { value: "", enabled: true, secret: true } }
					: {},
				children: [
					collection({
						name: "Tools",
						requests: [request({ name: "search_docs", method: "POST", url: SERVER })],
					}),
				],
			}),
		],
		meta: { format: "MCP server", requestCount: 1, folderCount: 1 },
	});
}

export function renderModal(client = new QueryClient()) {
	return render(
		<QueryClientProvider client={client}>
			<ImportModal />
		</QueryClientProvider>
	);
}

/** Radix tabs activate on mousedown, not a bare click (see ImportModal.curl.test.tsx). */
export function selectTab(name: RegExp) {
	const tab = screen.getByRole("tab", { name });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
}

export function urlInput(): HTMLInputElement {
	return screen.getByLabelText("Server URL") as HTMLInputElement;
}

export function tokenInput(): HTMLInputElement {
	return screen.getByLabelText(/Bearer token/) as HTMLInputElement;
}

export function connectButton(): HTMLButtonElement {
	return screen.getByRole("button", { name: /^Connect$/ }) as HTMLButtonElement;
}

export function openMcpTab(client?: QueryClient) {
	renderModal(client);
	selectTab(/^MCP server$/);
}

export function typeUrl(value = SERVER) {
	fireEvent.change(urlInput(), { target: { value } });
}

export function lastPayload(spy: ReturnType<typeof vi.spyOn>): ImportMcpRequest {
	return spy.mock.calls.at(-1)?.[0] as ImportMcpRequest;
}

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
 * The request builder's mirror of the collection AuthTab bug (issue #61).
 *
 * A request imported with digest/aws/ntlm auth read as "No Auth" and, because
 * the builder autosaves, the next edit silently wrote `{ mode: "none" }` back -
 * destroying config the user was never shown. The panel must name the stored
 * mode and warn, exactly as the collection AuthTab does, and hand the config
 * back untouched on save.
 *
 * The round-trip used to be a translation (`authToEditor`/`editorToAuth`) that
 * these tests had to go through; the panel now holds the domain `RequestAuth`
 * itself, so a stored mode survives by construction rather than by mapping.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import type { RequestAuth } from "@/types";
import AuthPanel from "./AuthPanel";

function renderPanel(auth: RequestAuth) {
	const updateField = vi.fn();
	const request = { auth, collectionId: null } as unknown as RequestState;
	const ctx = {
		request,
		updateField,
		setRequest: vi.fn(),
		resolveString: (s: string) => s,
		// The editable branches render VariableInput, which reads these.
		getAllVariables: () => ({}),
		getVariable: () => null,
		resolveVariables: (s: string) => s,
		updateVariable: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	// The inherit banner queries the collection chain, and the oauth2 fields
	// render tooltips - both are mounted at the app root in real use.
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const result = render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<RequestBuilderContext.Provider value={ctx}>
					<AuthPanel />
				</RequestBuilderContext.Provider>
			</TooltipProvider>
		</QueryClientProvider>
	);
	return { ...result, updateField };
}

describe("AuthPanel with an auth mode it cannot edit", () => {
	it("names the stored mode instead of reading No Auth", () => {
		renderPanel({ mode: "digest", config: { username: "u" } });

		expect(screen.getByText(/Digest auth is set/i)).toBeInTheDocument();
		expect(screen.getByText(/Picking a type above replaces it/i)).toBeInTheDocument();
		// The "No Auth" empty state is what the picker falls back to - it must not
		// claim the request has no auth when it has digest.
		expect(
			screen.queryByText(/No authentication will be sent with this request/i)
		).not.toBeInTheDocument();
	});

	it("labels aws and ntlm too", () => {
		renderPanel({ mode: "aws", config: {} });
		expect(screen.getByText(/AWS Signature auth is set/i)).toBeInTheDocument();

		renderPanel({ mode: "ntlm", config: {} });
		expect(screen.getByText(/NTLM auth is set/i)).toBeInTheDocument();
	});
});

describe("AuthPanel with an editable mode", () => {
	it("does not warn when the mode is one it understands", () => {
		renderPanel({ mode: "bearer", token: "abc" });
		expect(screen.queryByText(/not editable here/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/auth is set/i)).not.toBeInTheDocument();
	});

	it("shows the No Auth empty state when there genuinely is none", () => {
		renderPanel({ mode: "none" });
		expect(
			screen.getByText(/No authentication will be sent with this request/i)
		).toBeInTheDocument();
	});

	it("renders no credential fields for inherit - the banner resolves it instead", () => {
		renderPanel({ mode: "inherit" });
		expect(screen.queryByLabelText(/Token/i)).not.toBeInTheDocument();
		expect(
			screen.queryByText(/No authentication will be sent with this request/i)
		).not.toBeInTheDocument();
	});
});

describe("AuthPanel writes the domain shape", () => {
	/*
	 * The panel used to write a flat editor state (`authType` + `authConfig`,
	 * where apikey was "api-key" and `in` was `addTo`) that a mapper converted on
	 * every load, save and execute. It writes `RequestAuth` now, so picking a mode
	 * must store the domain object itself - a reappearing second vocabulary turns
	 * this red rather than being absorbed by a translation layer.
	 */
	it("stores the domain default for a newly picked mode", () => {
		const { updateField } = renderPanel({ mode: "none" });

		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: /API Key/i }));

		expect(updateField).toHaveBeenCalledWith("auth", {
			mode: "apikey",
			key: "",
			value: "",
			in: "header",
		});
	});

	it("offers inherit, which the collection editor must not", () => {
		// A collection is always a source; only a request may defer to its parent.
		renderPanel({ mode: "none" });
		fireEvent.click(screen.getByRole("combobox"));
		expect(
			screen.getByRole("option", { name: /Inherit from Collection/i })
		).toBeInTheDocument();
	});
});

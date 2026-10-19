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
import type { Collection, RequestAuth } from "@/types";
import AuthPanel from "./AuthPanel";

// The banner reads the ancestor chain through this hook; a test sets the chain
// it wants rather than seeding a query cache.
let ancestorChain: Collection[] = [];
vi.mock("@/queries/collections", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries/collections")>()),
	useCollectionAncestors: () => ancestorChain,
}));

function collection(name: string, auth: RequestAuth): Collection {
	return {
		id: name,
		name,
		description: "",
		order: 0,
		variables: {},
		auth,
		elements: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function renderPanel(auth: RequestAuth, collectionId: string | null = null) {
	const updateField = vi.fn();
	const request = { auth, collectionId } as unknown as RequestState;
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

	it("says Vayu does not send it, not that it is still sent", () => {
		renderPanel({ mode: "digest", config: { username: "u" } });

		expect(
			screen.getByText(
				/Vayu does not send this auth type, so the request goes out without auth/i
			)
		).toBeInTheDocument();
		expect(screen.queryByText(/still sent/i)).not.toBeInTheDocument();
	});

	it("says an inherited mode the engine ignores is not sent", () => {
		ancestorChain = [collection("root", { mode: "digest", config: {} })];
		renderPanel({ mode: "inherit" }, "root");

		expect(
			screen.getByText(
				/Vayu does not send this auth type, so this request goes out without auth/i
			)
		).toBeInTheDocument();
		ancestorChain = [];
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

describe("AuthPanel inherit banner notices", () => {
	/*
	 * The two "nothing to inherit" notices are the app's Callout, not a private
	 * copy of its box: a hand-rolled one drifts from the surface and icon the
	 * rest of the app's notices share (#2072).
	 */
	function noticeRoot(text: RegExp): HTMLElement {
		const root = screen.getByText(text).closest("div.rounded-md.border");
		if (!root) throw new Error("notice has no bordered root");
		return root as HTMLElement;
	}

	function expectCallout(root: HTMLElement) {
		expect(root.className).toContain("bg-panel");
		expect(root.className).not.toContain("bg-card");
		// Callout's leading icon is decorative and fixed per severity.
		expect(root.querySelector("svg[aria-hidden='true']")).not.toBeNull();
	}

	it("renders a request outside any collection as a Callout", () => {
		ancestorChain = [];
		renderPanel({ mode: "inherit" });

		const text = /isn't in a collection, so there's nothing to inherit from/i;
		expect(screen.getByText(text)).toBeInTheDocument();
		expect(screen.getByText(/No auth will be sent/i)).toBeInTheDocument();
		expectCallout(noticeRoot(text));
	});

	it("names the collection that blocks inheriting with No Auth", () => {
		ancestorChain = [collection("Payments", { mode: "noauth" })];
		renderPanel({ mode: "inherit" }, "Payments");

		const text = /is set to No\s+Auth, so nothing is inherited past it/i;
		expect(screen.getByText("Payments")).toBeInTheDocument();
		expect(screen.getByText(text, { exact: false })).toBeInTheDocument();
		expectCallout(noticeRoot(text));
	});

	it("says no ancestor defines auth when none does", () => {
		ancestorChain = [collection("Payments", { mode: "none" })];
		renderPanel({ mode: "inherit" }, "Payments");

		const text = /No ancestor collection defines auth/i;
		expect(screen.getByText(text, { exact: false })).toBeInTheDocument();
		expectCallout(noticeRoot(text));
	});

	it("keeps the resolution chain, not a Callout, when an ancestor supplies auth", () => {
		ancestorChain = [collection("Payments", { mode: "bearer", token: "abc" })];
		renderPanel({ mode: "inherit" }, "Payments");

		expect(screen.getByText("SOURCE")).toBeInTheDocument();
		expect(screen.queryByText(/nothing is inherited past it/i)).not.toBeInTheDocument();
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
			screen.getByRole("option", { name: /Inherit from collection/i })
		).toBeInTheDocument();
	});
});

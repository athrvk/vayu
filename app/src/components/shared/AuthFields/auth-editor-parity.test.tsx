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
 * Both auth editors, same fields (issue #105).
 *
 * The request `AuthPanel` and the collection `AuthTab` implemented bearer /
 * basic / api-key / none twice, independently, and drifted: only one explained
 * where credentials land, only one used the token editor, and "Add to" was a
 * `Select` on one side and a hand-rolled button group on the other. Nobody chose
 * any of those differences - they were what two copies do over time.
 *
 * A source scan cannot catch a regression here (CLAUDE.md: a class arriving in a
 * variable is invisible to one, and so is a re-hand-rolled field group), so this
 * renders both hosts with the same stored auth and compares what the user
 * actually sees. Re-implement either side and the shapes stop matching.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import type { Collection, RequestAuth } from "@/types";
import { RequestBuilderContext } from "@/modules/request-builder/context";
import type { RequestBuilderContextValue, RequestState } from "@/modules/request-builder/types";
import AuthPanel from "@/modules/request-builder/components/RequestTabs/panels/AuthPanel";
import AuthTab from "@/modules/collections/CollectionDetail/AuthTab";

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => ({
		mutate: vi.fn(),
		reset: vi.fn(),
		isPending: false,
		isError: false,
		error: null,
	}),
	// Both the inheritance chain and the request's inherit banner read this;
	// an empty chain keeps this file about the fields.
	useCollectionAncestors: () => [],
}));

function wrap(ui: React.ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={client}>
			<TooltipProvider>{ui}</TooltipProvider>
		</QueryClientProvider>
	);
}

function renderRequestEditor(auth: RequestAuth) {
	const ctx = {
		request: { auth, collectionId: null } as unknown as RequestState,
		updateField: vi.fn(),
		setRequest: vi.fn(),
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariable: () => null,
		resolveVariables: (s: string) => s,
		updateVariable: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	return render(
		wrap(
			<RequestBuilderContext.Provider value={ctx}>
				<AuthPanel />
			</RequestBuilderContext.Provider>
		)
	);
}

function renderCollectionEditor(auth: Collection["auth"]) {
	const collection: Collection = {
		id: "c1",
		name: "Acme API",
		description: "",
		order: 0,
		variables: {},
		auth,
		preRequestScript: "",
		postRequestScript: "",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
	return render(wrap(<AuthTab collection={collection} />));
}

/** The field labels a mode shows, in order - the shape being compared. */
function fieldLabels(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll("label")).map((l) => (l.textContent ?? "").trim());
}

const SHARED_CASES: Exclude<RequestAuth, { mode: "inherit" }>[] = [
	{ mode: "none" },
	{ mode: "bearer", token: "abc" },
	{ mode: "basic", username: "u", password: "p" },
	{ mode: "apikey", key: "X-API-Key", value: "v", in: "header" },
];

describe("the two auth editors render the same fields", () => {
	it.each(SHARED_CASES)("$mode", (auth) => {
		const request = renderRequestEditor(auth);
		// The request panel adds its own "Authentication Type" picker label; the
		// collection tab labels that control with a SectionLabel instead, so it is
		// dropped before comparing the credential fields themselves.
		const requestFields = fieldLabels(request.container).filter(
			(l) => l !== "Authentication Type"
		);
		request.unmount();

		const collection = renderCollectionEditor(auth);
		const collectionFields = fieldLabels(collection.container);

		expect(collectionFields).toEqual(requestFields);
	});

	it("explains where the credentials land on both sides", () => {
		// Only the request builder used to say this.
		const request = renderRequestEditor({ mode: "bearer", token: "t" });
		expect(screen.getByText(/Authorization: Bearer/i)).toBeInTheDocument();
		request.unmount();

		renderCollectionEditor({ mode: "bearer", token: "t" });
		expect(screen.getByText(/Authorization: Bearer/i)).toBeInTheDocument();
	});

	it("offers the api-key location as one control, not a Select on one side and buttons on the other", () => {
		const request = renderRequestEditor({
			mode: "apikey",
			key: "k",
			value: "v",
			in: "header",
		});
		// Two comboboxes on the request side: the auth-type picker and "Add to".
		expect(screen.getAllByRole("combobox")).toHaveLength(2);
		request.unmount();

		const collection = renderCollectionEditor({
			mode: "apikey",
			key: "k",
			value: "v",
			in: "header",
		});
		// One for the type picker, one for "Add to" - the hand-rolled button group
		// is gone, so there is no `button` pair standing in for it.
		expect(screen.getAllByRole("combobox")).toHaveLength(2);
		expect(
			within(collection.container).queryByRole("button", { name: /^Query param$/i })
		).not.toBeInTheDocument();
	});
});

describe("what the two editors are allowed to differ on", () => {
	it("only the request may inherit", () => {
		const request = renderRequestEditor({ mode: "none" });
		fireEvent.click(screen.getAllByRole("combobox")[0]);
		expect(
			screen.getByRole("option", { name: /Inherit from Collection/i })
		).toBeInTheDocument();
		request.unmount();

		renderCollectionEditor({ mode: "none" });
		fireEvent.click(screen.getAllByRole("combobox")[0]);
		expect(
			screen.queryByRole("option", { name: /Inherit from Collection/i })
		).not.toBeInTheDocument();
	});

	it("says No Auth in each host's own terms", () => {
		const request = renderRequestEditor({ mode: "none" });
		expect(
			screen.getByText(/No authentication will be sent with this request/i)
		).toBeInTheDocument();
		request.unmount();

		renderCollectionEditor({ mode: "none" });
		expect(screen.getByText(/No authentication for this collection/i)).toBeInTheDocument();
	});
});

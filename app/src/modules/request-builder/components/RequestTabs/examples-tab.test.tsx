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
 * The Examples tab - a request's saved example responses (issue #481).
 *
 * Two things have to hold. The tab must be a real member of the tab strip, or
 * Radix's roving focus skips it and it navigates nothing (the same property
 * `settings-tab.test.tsx` pins for its own tab). And the panel must keep three
 * states apart that all look like "nothing here": a request with no id cannot
 * have examples *yet*, a saved request may have none, and a failed read knows
 * nothing either way - collapsing them into one empty list is how a broken
 * engine reads as an empty collection.
 *
 * Rendered rather than source-scanned: the list arrives through a query hook,
 * so nothing static can see which branch drew.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RequestBuilderContext } from "../../context/RequestBuilderContext";
import type { RequestBuilderContextValue, RequestState } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import type { RequestExample } from "@/types";
import RequestTabs from "./index";

const listRequestExamples = vi.fn();
const deleteRequestExample = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		listRequestExamples: (id: string) => listRequestExamples(id),
		deleteRequestExample: (requestId: string, exampleId: string) =>
			deleteRequestExample(requestId, exampleId),
	},
}));

function renderExamplesTab(request: Partial<RequestState> = {}) {
	const value = {
		request: { ...createDefaultRequestState(), ...request },
		updateField: vi.fn(),
		setRequest: vi.fn(),
		activeTab: "examples",
		setActiveTab: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<RequestBuilderContext.Provider value={value}>
				<RequestTabs />
			</RequestBuilderContext.Provider>
		</QueryClientProvider>
	);
}

const example = (over: Partial<RequestExample> = {}): RequestExample => ({
	id: "exa_1",
	name: "200 OK",
	status: 200,
	headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
	body: '{"id":1}',
	contentType: "application/json",
	origin: "import",
	...over,
});

describe("Examples tab", () => {
	/*
	 * The spy is module-level, so without this the "never called" assertion
	 * below would read every earlier test's calls and fail for the wrong reason.
	 *
	 * Braces, not a bare arrow: `mockClear()` returns the mock, and vitest treats
	 * a function returned from `beforeEach` as a teardown callback - so an
	 * expression body has vitest *call the spy* after each test, with the last
	 * test's rejecting implementation still installed and nothing to receive it.
	 */
	beforeEach(() => {
		listRequestExamples.mockClear();
		deleteRequestExample.mockReset();
		deleteRequestExample.mockResolvedValue(undefined);
	});

	it("is a member of the tab strip, so it joins arrow-key navigation", () => {
		listRequestExamples.mockResolvedValue([]);
		renderExamplesTab({ id: "req_1" });
		const strip = screen.getByRole("tablist");
		expect(within(strip).getByRole("tab", { name: /examples/i })).toBeTruthy();
	});

	it("lists each stored example by status and name, in the order returned", async () => {
		listRequestExamples.mockResolvedValue([
			example(),
			example({ id: "exa_2", name: "Not found", status: 404 }),
		]);
		renderExamplesTab({ id: "req_1" });

		expect(await screen.findByText("200 OK")).toBeTruthy();
		expect(screen.getByText("Not found")).toBeTruthy();
		// The list order is the engine's `order`, which is what a mock server
		// resolves "the first example" against - so it is not re-sorted here.
		const names = screen.getAllByRole("button").map((b) => b.textContent ?? "");
		expect(names.findIndex((n) => n.includes("200 OK"))).toBeLessThan(
			names.findIndex((n) => n.includes("Not found"))
		);
	});

	it("shows the body and headers only once a row is expanded", async () => {
		listRequestExamples.mockResolvedValue([example()]);
		renderExamplesTab({ id: "req_1" });

		// By the expander's own state, not by its name: the delete button beside
		// it names the same example, so a name query matches two buttons.
		const row = await screen.findByRole("button", { expanded: false });
		expect(screen.queryByText("Content-Type")).toBeNull();

		row.click();
		// The header rows and the body viewer arrive together; the header list is
		// the half jsdom can read, since Monaco renders nothing here.
		expect(await screen.findByText("Content-Type")).toBeTruthy();
		expect(row.getAttribute("aria-expanded")).toBe("true");
	});

	it("says a saved request has no examples, and where they come from", async () => {
		listRequestExamples.mockResolvedValue([]);
		renderExamplesTab({ id: "req_1" });
		expect(await screen.findByText(/No example responses/i)).toBeTruthy();
	});

	it("tells an unsaved request to save first rather than showing an empty list", () => {
		renderExamplesTab({ id: undefined });
		expect(screen.getByText(/Save this request/i)).toBeTruthy();
		// Nothing to fetch without an id - the query stays disabled.
		expect(listRequestExamples).not.toHaveBeenCalled();
	});

	it("says the read failed rather than claiming there are none", async () => {
		listRequestExamples.mockRejectedValue(new Error("engine unreachable"));
		renderExamplesTab({ id: "req_1" });
		expect(await screen.findByText(/Could not load example responses/i)).toBeTruthy();
	});

	/*
	 * Where a row came from (issue #722). The engine has recorded `origin` since
	 * #588 and a spec sync acts on the two kinds differently - it rewrites a
	 * request's imported examples on any applied change and never touches a
	 * saved one - so a list that shows neither leaves the user unable to predict
	 * which rows the next sync owns.
	 */
	describe("the origin chip", () => {
		it("marks an imported row and leaves a saved one unmarked", async () => {
			listRequestExamples.mockResolvedValue([
				example({ origin: "import" }),
				example({ id: "exa_2", name: "Kept from a send", origin: "user" }),
			]);
			renderExamplesTab({ id: "req_1" });

			// One chip, on the imported row rather than merely somewhere on the
			// page - the whole point is which row it names.
			const chips = await screen.findAllByText("Imported");
			expect(chips).toHaveLength(1);
			// By the expanders, in list order: a name query matches the delete
			// button beside each row as well, which is why the tests above reach
			// for `expanded` too.
			const [imported, saved] = screen.getAllByRole("button", { expanded: false });
			expect(imported.textContent).toContain("200 OK");
			expect(imported.textContent).toContain("Imported");
			expect(saved.textContent).toContain("Kept from a send");
			expect(saved.textContent).not.toContain("Imported");
		});
	});

	/*
	 * Delete (issue #588). It landed with save-as-example because an example you
	 * can create and never remove is the #553 zombie shape at a smaller scale -
	 * and because a row a mock server answers with is not one to remove on a
	 * single stray click.
	 */
	describe("removing an example", () => {
		it("confirms first, then deletes through the owning request's path", async () => {
			listRequestExamples.mockResolvedValue([example()]);
			renderExamplesTab({ id: "req_1" });

			fireEvent.click(await screen.findByRole("button", { name: /delete example 200 OK/i }));
			expect(deleteRequestExample).not.toHaveBeenCalled();

			// The confirm says what a running mock does about it, since removing a
			// row can change what the next restart serves.
			expect(screen.getByText(/restarted/i)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

			await waitFor(() =>
				expect(deleteRequestExample).toHaveBeenCalledWith("req_1", "exa_1")
			);
		});

		/*
		 * The dialog used to promise "nothing here can bring it back" for every
		 * row, which was false for an imported one: the next sync of any field
		 * re-created it (issue #722). The engine keeps the delete now, so the
		 * promise holds - and the copy says which way each kind of row can still
		 * come back rather than asserting it cannot.
		 */
		it("tells an imported row what a sync and a re-import each do about it", async () => {
			listRequestExamples.mockResolvedValue([example({ origin: "import" })]);
			renderExamplesTab({ id: "req_1" });

			fireEvent.click(await screen.findByRole("button", { name: /delete example 200 OK/i }));
			expect(screen.getByText(/will not bring it back/i)).toBeTruthy();
			expect(screen.getByText(/re-importing the document will/i)).toBeTruthy();
			expect(screen.queryByText(/Nothing here can bring it back/i)).toBeNull();
		});

		it("tells a saved row that nothing brings it back", async () => {
			listRequestExamples.mockResolvedValue([example({ origin: "user" })]);
			renderExamplesTab({ id: "req_1" });

			fireEvent.click(await screen.findByRole("button", { name: /delete example 200 OK/i }));
			expect(screen.getByText(/Nothing here can bring it back/i)).toBeTruthy();
			expect(screen.queryByText(/re-importing the document/i)).toBeNull();
		});

		it("keeps the row and names the refusal when the engine says no", async () => {
			listRequestExamples.mockResolvedValue([example()]);
			deleteRequestExample.mockRejectedValue(new Error("Example not found"));
			renderExamplesTab({ id: "req_1" });

			fireEvent.click(await screen.findByRole("button", { name: /delete example 200 OK/i }));
			fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

			// A failed delete that closed the dialog would look like a delete that
			// worked until the list refreshed under it.
			expect(await screen.findByText(/Could not delete it/i)).toBeTruthy();
			// The row is still listed behind the dialog. By label rather than by
			// role: an open Radix dialog marks the page behind it aria-hidden, so a
			// role query cannot see a row that is plainly still there.
			expect(screen.getByLabelText(/delete example 200 OK/i)).toBeTruthy();
		});
	});
});

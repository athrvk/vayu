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
 * Send with a data row - the affordance's gating, its round trip, and the two
 * ways it is allowed to say no (issue #601).
 *
 * The gating is the half worth guarding, because both halves of it are
 * invisible in the component: a contract lives on a *collection* (possibly an
 * ancestor's, per the chain rule) and the file path lives in a machine-local
 * store. Either missing means the request has nothing to bind, and the rule is
 * **absent, not disabled** - a control offering "send with a row" where no row
 * exists is a promise the request cannot keep.
 *
 * The round trip is the other half: the picked row must reach `executeRequest`
 * as the row, unwrapped, because that is the object the engine binds and both
 * scripts read as `pm.iterationData`. A picker that opened, listed rows and
 * sent without one would look entirely correct.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import { emptyDrafts } from "../../utils/body-drafts";
import { TooltipProvider } from "@/components/ui";
import { useDataFileStore } from "@/stores";
import type { DataContractScope } from "@/types";
import UrlBar from "./index";

vi.mock("./MethodSelector", () => ({ default: () => null }));
vi.mock("./UrlInput", () => ({ default: () => null }));

const CONTRACT: DataContractScope = {
	collectionId: "col-users",
	collectionName: "Users",
	columns: ["id", "email"],
};

const CSV = "id,email\n7,ada@example.test\n8,grace@example.test\n";

/** The bytes the read IPC hands back, as the preload bridge shapes them. */
function csvBytes(text = CSV): { bytes: Uint8Array; fileName: string } {
	return { bytes: new TextEncoder().encode(text), fileName: "users.csv" };
}

function ctx(
	executeRequest: RequestBuilderContextValue["executeRequest"],
	dataColumns?: DataContractScope,
	requestId: string | null = null
): RequestBuilderContextValue {
	return {
		request: {
			...createDefaultRequestState(),
			id: requestId,
			url: "https://example.test/x",
		},
		setRequest: vi.fn(),
		updateField: vi.fn(),
		restoreStoredName: vi.fn(),
		getBodyDrafts: () => emptyDrafts(null),
		setBodyDrafts: vi.fn(),
		getVariablesDraft: () => null,
		setVariablesDraft: vi.fn(),
		getAutoContentType: () => null,
		setAutoContentType: vi.fn(),
		getAutoAccept: () => null,
		setAutoAccept: vi.fn(),
		response: null,
		setResponse: vi.fn(),
		activeTab: "params",
		setActiveTab: vi.fn(),
		isExecuting: false,
		isStreaming: false,
		stopStream: vi.fn(async () => {}),
		isSaving: false,
		hasUnsavedChanges: false,
		saveStatus: "idle",
		resolveString: (s: string) => s,
		resolveVariables: (s: string) => s,
		resolvedAuth: null,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: vi.fn(),
		writableScopes: [],
		dataColumns,
		executeRequest,
		saveRequest: vi.fn(async () => {}),
		startLoadTest: vi.fn(),
		canStartLoadTest: true,
	};
}

function renderBar(
	executeRequest: RequestBuilderContextValue["executeRequest"],
	dataColumns?: DataContractScope,
	requestId: string | null = null
) {
	return render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={ctx(executeRequest, dataColumns, requestId)}>
				<UrlBar />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

const caret = () => screen.queryByRole("button", { name: /send with a data row/i });

/** Radix's popover trigger toggles on click, which jsdom does synthesise. */
function openPicker() {
	fireEvent.click(caret()!);
}

beforeEach(() => {
	useDataFileStore.setState({ locations: {} });
});

afterEach(() => {
	cleanup();
	useDataFileStore.setState({ locations: {} });
	Reflect.deleteProperty(window, "electronAPI");
});

/** A declared file for the collection that declared the contract. */
function rememberFile(collectionId = CONTRACT.collectionId) {
	useDataFileStore
		.getState()
		.setDataFile(collectionId, { path: "/data/users.csv", fileName: "users.csv" });
}

/** The read IPC, answering with `text` - or rejecting, for the moved-file case. */
function stubReadDataFile(answer: () => Promise<{ bytes: Uint8Array; fileName: string }>) {
	const readDataFile = vi.fn(answer);
	Object.defineProperty(window, "electronAPI", {
		value: { readDataFile },
		configurable: true,
		writable: true,
	});
	return readDataFile;
}

describe("the Send-with-row affordance's availability", () => {
	it("is absent with no contract in scope, even when a file is remembered", () => {
		// The store is keyed by collection, so a stale entry for a collection that
		// has since cleared its contract must not resurrect the affordance.
		rememberFile();
		renderBar(
			vi.fn(async () => {}),
			undefined
		);
		expect(caret()).toBeNull();
	});

	it("is absent with a contract but no declared file", () => {
		renderBar(
			vi.fn(async () => {}),
			CONTRACT
		);
		expect(caret()).toBeNull();
	});

	it("appears when the contract and the file are both in scope", () => {
		rememberFile();
		renderBar(
			vi.fn(async () => {}),
			CONTRACT
		);
		expect(caret()).not.toBeNull();
	});

	/**
	 * The chain rule, which is the reason `DataContractScope` carries an id at
	 * all: a request in a sub-collection inherits an ancestor's contract, and
	 * the file was picked in *that* collection's Data tab. Looking the file up
	 * under the request's own parent would leave the affordance absent for
	 * exactly the nested case phase 2 went out of its way to support.
	 */
	it("finds the file under the collection that declared the contract, not the leaf", () => {
		rememberFile("col-users");
		renderBar(
			vi.fn(async () => {}),
			{ ...CONTRACT, collectionId: "col-users" }
		);
		expect(caret()).not.toBeNull();

		cleanup();
		useDataFileStore.setState({ locations: {} });
		rememberFile("some-other-collection");
		renderBar(
			vi.fn(async () => {}),
			CONTRACT
		);
		expect(caret()).toBeNull();
	});
});

describe("picking a row", () => {
	it("reads the file only when the picker is opened", async () => {
		rememberFile();
		const read = stubReadDataFile(async () => csvBytes());
		renderBar(
			vi.fn(async () => {}),
			CONTRACT
		);

		// Mounting a request tab must not touch the filesystem for a send nobody
		// asked for - the rows are user data and are read for one send at a time.
		expect(read).not.toHaveBeenCalled();

		openPicker();
		await waitFor(() => expect(read).toHaveBeenCalledWith("/data/users.csv"));
	});

	it("sends the chosen row itself, unwrapped", async () => {
		rememberFile();
		stubReadDataFile(async () => csvBytes());
		const executeRequest = vi.fn(async () => {});
		renderBar(executeRequest, CONTRACT);

		openPicker();
		const second = await screen.findByRole("button", { name: /grace@example\.test/ });
		fireEvent.click(second);

		// The row object, exactly as the parser produced it: this is what the
		// engine binds `{{data.*}}` against and what both scripts read as
		// `pm.iterationData`. A wrapper here would be a 400 the user cannot act on.
		expect(executeRequest).toHaveBeenCalledWith({ id: "8", email: "grace@example.test" });
	});

	it("leaves an ordinary Send with no row at all", async () => {
		rememberFile();
		stubReadDataFile(async () => csvBytes());
		const executeRequest = vi.fn(async () => {});
		renderBar(executeRequest, CONTRACT);

		fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
		// Not `undefined` passed along - no argument. An ordinary Send must reach
		// the engine as the payload it always was, so `pm.iterationData` stays
		// `undefined` and `{{data.*}}` tokens keep today's behaviour.
		expect(executeRequest).toHaveBeenCalledWith();
	});

	it("says the file moved rather than failing silently", async () => {
		rememberFile();
		stubReadDataFile(async () => {
			throw new Error("ENOENT: no such file or directory, open '/data/users.csv'");
		});
		renderBar(
			vi.fn(async () => {}),
			CONTRACT
		);

		openPicker();
		// The message is the engine-or-IPC one, shown where the rows would have
		// been: picking the file again in the Data tab is the whole fix, and a
		// toast that scrolled away would not say what to do.
		expect(await screen.findByText(/no such file or directory/i)).toBeTruthy();
	});
});

describe("the caret's place in the attached group", () => {
	it("squares Send's right edge when the caret joins it", () => {
		rememberFile();
		renderBar(
			vi.fn(async () => {}),
			CONTRACT
		);
		const send = screen.getByRole("button", { name: /^send$/i });
		expect(send.className).toContain("rounded-r-none");
	});

	/**
	 * The corner rule is "Send is alone", not "there is no Load Test" - with the
	 * caret present Send is never alone, and a group whose members all keep a
	 * squared outer edge looks broken rather than deliberate.
	 */
	it("gives the caret the right corner when nothing follows it", () => {
		rememberFile();
		render(
			<TooltipProvider>
				<RequestBuilderContext.Provider
					value={{
						...ctx(
							vi.fn(async () => {}),
							CONTRACT
						),
						canStartLoadTest: false,
					}}
				>
					<UrlBar />
				</RequestBuilderContext.Provider>
			</TooltipProvider>
		);
		expect(caret()!.className).toContain("rounded-r-md");
		expect(screen.getByRole("button", { name: /^send$/i }).className).toContain(
			"rounded-r-none"
		);
	});

	/**
	 * While a stream is open Send *is* Stop, and a caret beside it would offer
	 * to start the very run it is ending.
	 */
	it("disappears while a stream is open", () => {
		rememberFile();
		render(
			<TooltipProvider>
				<RequestBuilderContext.Provider
					value={{
						...ctx(
							vi.fn(async () => {}),
							CONTRACT
						),
						isStreaming: true,
					}}
				>
					<UrlBar />
				</RequestBuilderContext.Provider>
			</TooltipProvider>
		);
		expect(caret()).toBeNull();
		expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
	});
});

/**
 * The remembered row is per request, not per builder (issue #659 item 1).
 *
 * `Shell` renders `<RequestBuilder />` at the same position for every request
 * tab and does not key it, so switching tabs does *not* remount this component -
 * React keeps the instance and everything in its `useState`. The remembered
 * index was one number in that state, so it followed the user from request to
 * request: the highlight, and the row a one-click re-send binds, belonged to
 * whichever request picked last.
 *
 * These drive that switch the way the shell does - a re-render with a different
 * request in context, no unmount - because a test that mounted a second UrlBar
 * would pass against the broken version.
 */
describe("the remembered row", () => {
	/** The picker's row buttons, in order, once it is open. */
	async function openRows() {
		openPicker();
		await screen.findByRole("button", { name: /ada@example\.test/ });
		return screen
			.getAllByRole("button")
			.filter((el) => /@example\.test/.test(el.textContent ?? ""));
	}

	it("does not follow the user to the next request tab", async () => {
		rememberFile();
		stubReadDataFile(async () => csvBytes());
		const execute = vi.fn(async () => {});
		const { rerender } = renderBar(execute, CONTRACT, "req_a");

		// Pick the second row on request A. The picker closes on send.
		const rows = await openRows();
		fireEvent.click(rows[1]);
		await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

		// Reopening on A still shows the pick - the feature this must not break.
		const backOnA = await openRows();
		expect(backOnA[1].className).toContain("bg-accent");
		fireEvent.keyDown(document.body, { key: "Escape" });

		// The tab switch: same mounted builder, different request.
		rerender(
			<TooltipProvider>
				<RequestBuilderContext.Provider value={ctx(execute, CONTRACT, "req_b")}>
					<UrlBar />
				</RequestBuilderContext.Provider>
			</TooltipProvider>
		);

		const onB = await openRows();
		for (const row of onB) {
			expect(row.className).not.toContain("bg-accent/60");
		}
	});

	it("comes back when the user returns to the request that made it", async () => {
		rememberFile();
		stubReadDataFile(async () => csvBytes());
		const execute = vi.fn(async () => {});
		const { rerender } = renderBar(execute, CONTRACT, "req_a");

		const rows = await openRows();
		fireEvent.click(rows[1]);
		await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

		const switchTo = (requestId: string) =>
			rerender(
				<TooltipProvider>
					<RequestBuilderContext.Provider value={ctx(execute, CONTRACT, requestId)}>
						<UrlBar />
					</RequestBuilderContext.Provider>
				</TooltipProvider>
			);

		switchTo("req_b");
		switchTo("req_a");

		// A map, not a reset: forgetting on every switch would pass the test
		// above and lose the affordance's whole point.
		const backOnA = await openRows();
		expect(backOnA[1].className).toContain("bg-accent");
	});
});

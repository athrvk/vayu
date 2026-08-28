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
import { useCallback, useState } from "react";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import { emptyDrafts } from "../../utils/body-drafts";
import { TooltipProvider } from "@/components/ui";
import { useDataFileStore, useTabsStore } from "@/stores";
import type { DataContractScope } from "@/types";
import { useSendWithRow } from "../../hooks/useSendWithRow";
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
	dataColumns: DataContractScope | undefined,
	requestId: string | null,
	sendWithRow: RequestBuilderContextValue["sendWithRow"],
	lastRowIndex: number | null,
	rememberRowIndex: (index: number) => void
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
		sendWithRow,
		lastRowIndex,
		rememberRowIndex,
		executeRequest,
		saveRequest: vi.fn(async () => {}),
		startLoadTest: vi.fn(),
		canStartLoadTest: true,
	};
}

/**
 * The provider's Send-with-row state, and nothing else it holds.
 *
 * The rows and the picked index moved onto the context in issue #1062, so the
 * bar can no longer read them for itself - but the read they come from is the
 * half of this file's gating that is worth exercising for real (a contract, a
 * remembered location, an IPC read that may fail), so the harness drives the
 * *actual* hook rather than handing the bar a fixed answer. What it restates of
 * the provider is the two lines of index memory beside it, deliberately kept
 * that small.
 */
function Harness({
	executeRequest,
	dataColumns,
	requestId,
	dataFileMaxRows = 1000,
	overrides,
}: {
	executeRequest: RequestBuilderContextValue["executeRequest"];
	dataColumns?: DataContractScope;
	requestId: string | null;
	dataFileMaxRows?: number;
	overrides?: Partial<RequestBuilderContextValue>;
}) {
	const sendWithRow = useSendWithRow(dataColumns, dataFileMaxRows);
	/*
	 * Keyed by request exactly as the provider keys it (issue #659 item 1), so
	 * the two cases below that switch request tabs still see what the bar sees.
	 * The keying *rule* is the provider's and is pinned there, in
	 * `RequestBuilderProvider.bound-row.test.tsx`; what these cases pin is that
	 * the bar reads `lastRowIndex` off the context rather than remembering a
	 * pick of its own.
	 */
	const [rowIndexByRequest, setRowIndexByRequest] = useState<Record<string, number>>({});
	const rowMemoryKey = requestId ?? "__unsaved__";
	const rememberRowIndex = useCallback(
		(index: number) => setRowIndexByRequest((previous) => ({ ...previous, [rowMemoryKey]: index })),
		[rowMemoryKey]
	);
	return (
		<RequestBuilderContext.Provider
			value={{
				...ctx(
					executeRequest,
					dataColumns,
					requestId,
					sendWithRow,
					rowIndexByRequest[rowMemoryKey] ?? null,
					rememberRowIndex
				),
				...overrides,
			}}
		>
			<UrlBar />
		</RequestBuilderContext.Provider>
	);
}

function renderBar(
	executeRequest: RequestBuilderContextValue["executeRequest"],
	dataColumns?: DataContractScope,
	requestId: string | null = null,
	dataFileMaxRows?: number
) {
	return render(
		<TooltipProvider>
			<Harness
				executeRequest={executeRequest}
				dataColumns={dataColumns}
				requestId={requestId}
				dataFileMaxRows={dataFileMaxRows}
			/>
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
	useTabsStore.setState({ dataRowTarget: null });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
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
		const second = await screen.findByRole("row", { name: /grace@example\.test/ });
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

	it("offers no rows out of a file over the run's row cap, naming the setting", async () => {
		// Two data rows against a cap of one (issue #751). The file is the
		// collection's data set, so one the picker would refuse - and `POST /runs`
		// after it - is not a set to bind a Send from.
		rememberFile();
		stubReadDataFile(async () => csvBytes());
		renderBar(
			vi.fn(async () => {}),
			CONTRACT,
			null,
			1
		);

		openPicker();

		expect(
			await screen.findByText(/2 rows, over the 1[\s\S]*maxScenarioDataRows/)
		).toBeTruthy();
		expect(screen.queryByText(/ada@example\.test/)).toBeNull();
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
				<Harness
					executeRequest={vi.fn(async () => {})}
					dataColumns={CONTRACT}
					requestId={null}
					overrides={{ canStartLoadTest: false }}
				/>
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
				<Harness
					executeRequest={vi.fn(async () => {})}
					dataColumns={CONTRACT}
					requestId={null}
					overrides={{ isStreaming: true }}
				/>
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
	/**
	 * The picker's data rows, in file order, once it is open.
	 *
	 * Filtered by content rather than sliced past the header: the grid's header
	 * is a `role="row"` too, so `getAllByRole("row")[1]` would be row 1 of the
	 * file and reading it as row 2 is exactly the off-by-one this suite exists to
	 * catch.
	 */
	async function openRows() {
		openPicker();
		await screen.findByRole("row", { name: /ada@example\.test/ });
		return screen
			.getAllByRole("row")
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
				<Harness executeRequest={execute} dataColumns={CONTRACT} requestId="req_b" />
			</TooltipProvider>
		);

		/*
		 * B shows the *default* pick, row 1 - not A's row 2. It used to show none
		 * at all, and that was the assertion here; the dialog has a footer that
		 * names the row it will send (issue #892), so "nothing is selected" is no
		 * longer a state it can be in and coherently offer that button. The
		 * guarantee this test exists for is unchanged and now checked more
		 * directly: what B highlights must not be what A picked.
		 */
		const onB = await openRows();
		expect(onB[0].className).toContain("bg-accent/60");
		expect(onB[1].className).not.toContain("bg-accent/60");
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
					<Harness executeRequest={execute} dataColumns={CONTRACT} requestId={requestId} />
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

/**
 * Reaching a row the list does not show, and arriving from a failed step
 * (issue #730).
 *
 * The list *was* the first 20 rows by design - a popover is not the file - so
 * before #730 the rows past it were unreachable from here at all, which is
 * precisely the row a long run's failure names ("iteration 501 · row 501").
 * Issue #892 made the picker a dialog and put every row in it, so the number
 * field is now the shortcut to a distant row rather than the only route to it -
 * these still guard it, because typing an index is how a step's repro is
 * followed and how a 500-row file is navigated without scrolling.
 */
describe("any row in the file", () => {
	/** A file of `count` rows, so the browse window is not the whole of it. */
	const bigCsv = (count: number) =>
		["id,email", ...Array.from({ length: count }, (_, i) => `${i},user${i}@example.test`)].join(
			"\n"
		);

	const numberField = () => screen.getByLabelText(/send with a row by number/i);

	async function openBigPicker(count = 60) {
		rememberFile();
		stubReadDataFile(async () => csvBytes(bigCsv(count)));
		const execute = vi.fn(async () => {});
		renderBar(execute, CONTRACT, "req_a");
		openPicker();
		await screen.findByRole("row", { name: /user0@example\.test/ });
		return execute;
	}

	it("sends a row past the browse window, reached by number", async () => {
		const execute = await openBigPicker();

		fireEvent.change(numberField(), { target: { value: "51" } });

		// In the grid itself and scrolled to, not pinned above the list: every row
		// is rendered now, so there is something to scroll to.
		const pinned = screen.getByRole("row", { name: /user50@example\.test/ });
		fireEvent.click(pinned);

		await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
		expect(execute).toHaveBeenCalledWith({ id: "50", email: "user50@example.test" });
	});

	it("sends on Enter, so reaching a row is typing its number", async () => {
		const execute = await openBigPicker();

		fireEvent.change(numberField(), { target: { value: "44" } });
		fireEvent.keyDown(numberField(), { key: "Enter" });

		await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
		expect(execute).toHaveBeenCalledWith({ id: "43", email: "user43@example.test" });
	});

	it("refuses a number the file has no row for, naming what it has", async () => {
		const execute = await openBigPicker(60);

		fireEvent.change(numberField(), { target: { value: "900" } });
		fireEvent.keyDown(numberField(), { key: "Enter" });

		// Refused rather than clamped to the last row: a send bound to a row the
		// user did not ask for is worse than no send at all.
		expect(execute).not.toHaveBeenCalled();
		expect(screen.getByText(/the file has 60 rows/i)).toBeTruthy();
		expect(numberField()).toHaveAttribute("aria-invalid", "true");
	});

	it("refuses an entry that is not a row number", async () => {
		const execute = await openBigPicker();

		fireEvent.change(numberField(), { target: { value: "4a" } });
		fireEvent.keyDown(numberField(), { key: "Enter" });

		expect(execute).not.toHaveBeenCalled();
		expect(screen.getByText(/row numbers are digits/i)).toBeTruthy();
	});

	it("reaches a row past the old browse window by scrolling, with no number typed", async () => {
		// The popover showed twenty rows and made the number field the only way to
		// the twenty-first (issue #892). A dialog has the room, so every row is in
		// the list and the number field is a shortcut rather than the mechanism.
		await openBigPicker(60);
		expect(screen.getByRole("row", { name: /user0@example\.test/ })).toBeTruthy();
		expect(screen.getByRole("row", { name: /user30@example\.test/ })).toBeTruthy();
		expect(screen.getByRole("row", { name: /user59@example\.test/ })).toBeTruthy();
	});
});

/**
 * The row picker is a dialog, not a popover (issue #892).
 *
 * The popover was ~384px wide over the response pane, and every constraint the
 * old design worked around came from that box: a row was one truncated line with
 * the column name repeated in front of every cell
 * (`userId=1001 email=ada@example.com plan=pro q…`), twenty of them, and a
 * number field standing in for the rows it had no room to show. Picking a row
 * out of that meant reading a sentence rather than scanning a column.
 */
describe("the row picker as a dialog", () => {
	const csv = [
		"userId,email,plan",
		"1001,ada@example.com,pro",
		"1002,grace@example.com,free",
		"1003,alan@example.com,enterprise",
	].join("\n");

	async function openDialog() {
		rememberFile();
		stubReadDataFile(async () => csvBytes(csv));
		const execute = vi.fn(async () => {});
		renderBar(execute, CONTRACT, "req_a");
		openPicker();
		await screen.findByRole("row", { name: /ada@example\.com/ });
		return execute;
	}

	it("opens as a modal dialog with an accessible name", async () => {
		await openDialog();
		const dialog = screen.getByRole("dialog");
		expect(dialog).toBeTruthy();
		expect(dialog.textContent).toContain("Send with a data row");
	});

	it("names each column once, in a header, instead of on every cell", async () => {
		await openDialog();

		// The header carries the column names...
		for (const column of ["userId", "email", "plan"]) {
			expect(screen.getByRole("columnheader", { name: column })).toBeTruthy();
		}
		// ...and a row is its values, so the name is not repeated per cell. This
		// is the whole readability complaint: `userId=1001` on every line.
		const row = screen.getByRole("row", { name: /ada@example\.com/ });
		expect(row.textContent).not.toContain("userId=");
		expect(row.textContent).not.toContain("email=");
	});

	it("shows the row's number beside its values", async () => {
		await openDialog();
		const row = screen.getByRole("row", { name: /grace@example\.com/ });
		// One-based, matching the number field and the run report's row index.
		expect(row.textContent).toContain("2");
		expect(row.textContent).toContain("free");
	});

	it("narrows the rows to what the filter matches, across every column", async () => {
		await openDialog();
		const filter = screen.getByLabelText(/filter rows/i);

		fireEvent.change(filter, { target: { value: "enterprise" } });
		expect(screen.queryByRole("row", { name: /alan@example\.com/ })).toBeTruthy();
		expect(screen.queryByRole("row", { name: /ada@example\.com/ })).toBeNull();

		// Case-insensitive, and it reads the whole row rather than one column.
		fireEvent.change(filter, { target: { value: "GRACE" } });
		expect(screen.queryByRole("row", { name: /grace@example\.com/ })).toBeTruthy();
		expect(screen.queryByRole("row", { name: /alan@example\.com/ })).toBeNull();
	});

	it("says so when the filter matches nothing, rather than showing an empty box", async () => {
		await openDialog();
		fireEvent.change(screen.getByLabelText(/filter rows/i), {
			target: { value: "nosuchvalue" },
		});
		expect(screen.getByText(/no rows match/i)).toBeTruthy();
	});

	it("sends the selected row from the footer, for a row reached by typing", async () => {
		const execute = await openDialog();

		fireEvent.change(screen.getByLabelText(/send with a row by number/i), {
			target: { value: "3" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^send row 3$/i }));

		await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
		expect(execute).toHaveBeenCalledWith({
			userId: "1003",
			email: "alan@example.com",
			plan: "enterprise",
		});
	});

	it("still sends on a row click, so the fast loop stays one click", async () => {
		const execute = await openDialog();
		fireEvent.click(screen.getByRole("row", { name: /ada@example\.com/ }));

		await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
		expect(execute).toHaveBeenCalledWith({
			userId: "1001",
			email: "ada@example.com",
			plan: "pro",
		});
	});

	it("counts the file's rows and columns in the header", async () => {
		await openDialog();
		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("3 rows");
		expect(dialog.textContent).toContain("3 columns");
	});
});

describe("arriving from a failed step", () => {
	const bigCsv = (count: number) =>
		["id,email", ...Array.from({ length: count }, (_, i) => `${i},user${i}@example.test`)].join(
			"\n"
		);

	it("opens the list on the row that step bound, without a click", async () => {
		rememberFile();
		stubReadDataFile(async () => csvBytes(bigCsv(600)));
		const execute = vi.fn(async () => {});

		// What `openRequestWithDataRow` leaves behind for this tab: the request
		// is already open, and the row is the half `openTab` cannot carry.
		useTabsStore.setState({ dataRowTarget: { requestId: "req_a", rowIndex: 500 } });
		renderBar(execute, CONTRACT, "req_a");

		// Two clicks from the step card to the repro: the card's, and this one.
		const row = await screen.findByRole("row", { name: /user500@example\.test/ });
		fireEvent.click(row);

		await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
		expect(execute).toHaveBeenCalledWith({ id: "500", email: "user500@example.test" });
	});

	it("consumes the target, so a later visit opens on nothing", async () => {
		rememberFile();
		stubReadDataFile(async () => csvBytes(bigCsv(30)));
		useTabsStore.setState({ dataRowTarget: { requestId: "req_a", rowIndex: 25 } });
		renderBar(
			vi.fn(async () => {}),
			CONTRACT,
			"req_a"
		);

		await screen.findByRole("row", { name: /user25@example\.test/ });
		expect(useTabsStore.getState().dataRowTarget).toBeNull();
	});

	it("leaves a target for a different request alone", async () => {
		rememberFile();
		stubReadDataFile(async () => csvBytes(bigCsv(30)));
		useTabsStore.setState({ dataRowTarget: { requestId: "req_b", rowIndex: 4 } });
		renderBar(
			vi.fn(async () => {}),
			CONTRACT,
			"req_a"
		);

		// Not this tab's navigation: the list stays shut and the target waits for
		// the tab it names.
		expect(screen.queryByLabelText(/send with a row by number/i)).toBeNull();
		expect(useTabsStore.getState().dataRowTarget).toEqual({
			requestId: "req_b",
			rowIndex: 4,
		});
	});

	it("clears a target for a request that cannot bind rows at all", () => {
		// No contract in scope, so there is no picker to open. The target must
		// still be consumed, or it fires on the next request that has one.
		useTabsStore.setState({ dataRowTarget: { requestId: "req_a", rowIndex: 2 } });
		renderBar(
			vi.fn(async () => {}),
			undefined,
			"req_a"
		);

		expect(caret()).toBeNull();
		expect(useTabsStore.getState().dataRowTarget).toBeNull();
	});
});

/**
 * The grid's keyboard model (issue #936).
 *
 * A roving tabindex is a promise of *one* tab stop, and the grid made it by
 * hanging `tabIndex=0` off the selected row - an address into the file, which
 * three ordinary states put outside the rows on screen: a remembered index past
 * the 100-row window, a filter that excludes it, and a file that shrank under it.
 * Each of those left **zero** rows focusable, so the grid dropped out of the tab
 * order entirely and the key handler below became unreachable.
 *
 * The other half is what a screen reader hears: arrow keys moved
 * `aria-selected` through state and never moved DOM focus, so the ring stayed on
 * the old row and nothing was announced. These assert both, on the rendered DOM
 * rather than on the source, because the defect is what the browser is handed.
 */
describe("the grid's keyboard model", () => {
	const bigCsv = (count: number) =>
		["id,email", ...Array.from({ length: count }, (_, i) => `${i},user${i}@example.test`)].join(
			"\n"
		);

	/** Every data row on screen, header excluded (the header is a `row` too). */
	const dataRows = () =>
		screen.getAllByRole("row").filter((el) => /@example\.test/.test(el.textContent ?? ""));

	const tabStops = () => dataRows().filter((el) => el.getAttribute("tabindex") === "0");

	async function openWith(count: number, rowIndex: number | null = null) {
		rememberFile();
		stubReadDataFile(async () => csvBytes(bigCsv(count)));
		const execute = vi.fn(async () => {});
		if (rowIndex !== null) {
			useTabsStore.setState({ dataRowTarget: { requestId: "req_a", rowIndex } });
		}
		renderBar(execute, CONTRACT, "req_a");
		if (rowIndex === null) openPicker();
		await screen.findByRole("row", { name: /user0@example\.test/ });
		return execute;
	}

	it("keeps exactly one tab stop for a remembered row past the browse window", async () => {
		// `useGrowingWindow` renders everything where there is no
		// `IntersectionObserver` - jsdom has none - so a real window needs one
		// that observes and never fires. Without this the window is the whole
		// file here and the case the app hits at row 101 cannot be reached at all.
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe() {}
				disconnect() {}
				unobserve() {}
			}
		);

		// 300 rows, opened on row 251: the window renders the first 100, so the
		// selected row has no element and the roving assignment had nothing to
		// land on. The grid must still be reachable by Tab.
		await openWith(300, 250);

		expect(screen.queryByRole("row", { name: /user250@example\.test/ })).toBeNull();
		expect(tabStops()).toHaveLength(1);
		// The fallback is the first rendered row, and it is only the *tab stop* -
		// the selection still names row 251, which is what the footer sends.
		expect(tabStops()[0].textContent).toContain("user0@example.test");
		expect(screen.getByRole("button", { name: /^send row 251$/i })).toBeTruthy();
	});

	it("keeps exactly one tab stop when the filter excludes the selected row", async () => {
		await openWith(30, 3);
		expect(tabStops()).toHaveLength(1);

		fireEvent.change(screen.getByLabelText(/filter rows/i), {
			target: { value: "user21@" },
		});
		expect(screen.queryByRole("row", { name: /user3@example\.test/ })).toBeNull();
		expect(tabStops()).toHaveLength(1);
		expect(tabStops()[0].textContent).toContain("user21@example.test");
	});

	it("keeps exactly one tab stop when the file shrank under the remembered row", async () => {
		// #894's state: the selection is refused rather than clamped, so it points
		// past the file - and the rows that *are* there still have to be reachable.
		await openWith(5, 25);
		expect(screen.getByText(/row 26 no longer exists/i)).toBeTruthy();
		expect(tabStops()).toHaveLength(1);
		expect(screen.getByRole("button", { name: /^send row 26$/i })).toBeDisabled();
	});

	it("moves DOM focus with the selection on arrow keys", async () => {
		await openWith(30);
		const rows = dataRows();
		rows[0].focus();
		expect(document.activeElement).toBe(rows[0]);

		fireEvent.keyDown(rows[0], { key: "ArrowDown" });
		expect(dataRows()[1].getAttribute("aria-selected")).toBe("true");
		// Both, not one: `aria-selected` alone leaves the ring and the screen
		// reader's cursor on the row the user just left.
		expect(document.activeElement).toBe(dataRows()[1]);
		expect(dataRows()[1].getAttribute("tabindex")).toBe("0");
		expect(dataRows()[0].getAttribute("tabindex")).toBe("-1");

		fireEvent.keyDown(dataRows()[1], { key: "ArrowUp" });
		expect(dataRows()[0].getAttribute("aria-selected")).toBe("true");
		expect(document.activeElement).toBe(dataRows()[0]);
	});

	it("takes Home, End and the page keys to the ends of the rendered rows", async () => {
		await openWith(30);
		const rows = dataRows();
		rows[0].focus();

		fireEvent.keyDown(rows[0], { key: "End" });
		expect(document.activeElement).toBe(dataRows()[29]);
		expect(dataRows()[29].getAttribute("aria-selected")).toBe("true");

		fireEvent.keyDown(dataRows()[29], { key: "PageUp" });
		expect(document.activeElement).toBe(dataRows()[19]);

		fireEvent.keyDown(dataRows()[19], { key: "PageDown" });
		expect(document.activeElement).toBe(dataRows()[29]);

		fireEvent.keyDown(dataRows()[29], { key: "Home" });
		expect(document.activeElement).toBe(dataRows()[0]);
		expect(dataRows()[0].getAttribute("aria-selected")).toBe("true");
	});

	it("leaves focus in the number field while a row number is typed", async () => {
		// The arrow keys move the selection *through* this field's state, so a
		// focus that followed every change would pull the caret out of it mid-number.
		await openWith(30);
		const field = screen.getByLabelText(/send with a row by number/i);
		field.focus();
		fireEvent.change(field, { target: { value: "12" } });

		expect(dataRows()[11].getAttribute("aria-selected")).toBe("true");
		expect(document.activeElement).toBe(field);
	});

	it("sends the row the keyboard walked to", async () => {
		const execute = await openWith(30);
		const rows = dataRows();
		rows[0].focus();

		fireEvent.keyDown(rows[0], { key: "ArrowDown" });
		fireEvent.keyDown(dataRows()[1], { key: "ArrowDown" });
		fireEvent.keyDown(dataRows()[2], { key: "Enter" });

		await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
		expect(execute).toHaveBeenCalledWith({ id: "2", email: "user2@example.test" });
	});
});

/**
 * A remembered row that outlived the file it pointed into (issue #894).
 *
 * The typed field refuses a row the file has no row for, and the two indices
 * nobody types - the remembered one and a step card's repro target - did not:
 * neither is clamped, and the file underneath them can shrink between the send
 * that recorded one and the reopen that reads it (an edited file, a re-picked
 * one, or a lowered `maxScenarioDataRows` cutting the loaded set with no file
 * change at all). The footer still read "Send row N", and clicking it sent the
 * request with every `{{data.*}}` token unbound and nothing naming why.
 *
 * So these assert the refusal on both sides of it: the visible one (the footer
 * dead, the reason stated) and the send funnel itself, which is what makes the
 * silent send unreachable rather than merely hard to reach.
 */
describe("a row the file no longer has", () => {
	const bigCsv = (count: number) =>
		["id,email", ...Array.from({ length: count }, (_, i) => `${i},user${i}@example.test`)].join(
			"\n"
		);

	/** The grid's own Enter, which sends the selected row without a click. */
	const pressEnterOnGrid = () =>
		fireEvent.keyDown(screen.getByRole("row", { name: /user0@example\.test/ }), {
			key: "Enter",
		});

	it("refuses a remembered row after the file shrank under it", async () => {
		rememberFile();
		// The same declared path, read twice: 30 rows when the row was picked, 5
		// by the time the picker is reopened.
		let rows = 30;
		stubReadDataFile(async () => csvBytes(bigCsv(rows)));
		const execute = vi.fn(async () => {});
		renderBar(execute, CONTRACT, "req_a");

		openPicker();
		fireEvent.click(await screen.findByRole("row", { name: /user25@example\.test/ }));
		await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

		rows = 5;
		openPicker();
		await screen.findByRole("row", { name: /user4@example\.test/ });

		// Named, not clamped to row 5: which row was asked for is the thing that
		// went wrong, and binding a different one would say nothing about it.
		expect(screen.getByText(/row 26 no longer exists - the file has 5 rows/i)).toBeTruthy();

		const footer = screen.getByRole("button", { name: /^send row 26$/i });
		expect(footer).toBeDisabled();
		fireEvent.click(footer);
		pressEnterOnGrid();
		// Still the one send from before the file shrank: neither path reached
		// `executeRequest` with no row bound.
		expect(execute).toHaveBeenCalledTimes(1);

		// Not a dead end - picking a row that does exist sends as it always did.
		fireEvent.click(screen.getByRole("row", { name: /user3@example\.test/ }));
		await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
		expect(execute).toHaveBeenLastCalledWith({ id: "3", email: "user3@example.test" });
	});

	it("refuses a step's repro target the file has no row for", async () => {
		// What `openRequestWithDataRow` leaves behind (issue #730), pointing past
		// a file that no longer runs to 501 rows. The dialog opens on it without a
		// click, so this state is reached with nothing typed and nothing picked.
		rememberFile();
		stubReadDataFile(async () => csvBytes(bigCsv(30)));
		const execute = vi.fn(async () => {});
		useTabsStore.setState({ dataRowTarget: { requestId: "req_a", rowIndex: 500 } });
		renderBar(execute, CONTRACT, "req_a");

		await screen.findByRole("row", { name: /user0@example\.test/ });
		expect(screen.getByText(/row 501 no longer exists - the file has 30 rows/i)).toBeTruthy();

		const footer = screen.getByRole("button", { name: /^send row 501$/i });
		expect(footer).toBeDisabled();
		fireEvent.click(footer);
		pressEnterOnGrid();
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps offering the row it names while the row is in the file", async () => {
		// The guard's other half: a remembered index inside the file must not be
		// refused, or the fix would have cost the feature its one-click re-send.
		rememberFile();
		stubReadDataFile(async () => csvBytes(bigCsv(30)));
		const execute = vi.fn(async () => {});
		useTabsStore.setState({ dataRowTarget: { requestId: "req_a", rowIndex: 25 } });
		renderBar(execute, CONTRACT, "req_a");

		await screen.findByRole("row", { name: /user25@example\.test/ });
		expect(screen.queryByText(/no longer exists/i)).toBeNull();

		const footer = screen.getByRole("button", { name: /^send row 26$/i });
		expect(footer).not.toBeDisabled();
		fireEvent.click(footer);
		await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
		expect(execute).toHaveBeenCalledWith({ id: "25", email: "user25@example.test" });
	});
});

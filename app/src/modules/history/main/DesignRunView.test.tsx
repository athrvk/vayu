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
 * A design run opens as an editable copy of what was sent.
 *
 * The two things that matter here are what the copy shows and what it does
 * *not* do. It shows the stored exchange - the response pane is seeded from the
 * run rather than from the response store, which is keyed by request id and so
 * has nothing for a copy whose id is null.
 *
 * And it never saves. Note that **two independent gates** stop the write, and
 * either alone is sufficient: `useSaveManager` early-returns on `!entityId`
 * (the seed sets `id: null`), and the provider passes `enabled: !!onSave` (the
 * view passes no `onSave`). So the mutation check for "does not save" has to
 * remove *both* - adding an `onSave` on its own leaves the test green, because
 * the null id still blocks it. That is not a weak test; it is two guards doing
 * the same job on purpose. `design-run-seed.test.ts` pins `id: null` separately.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import DesignRunView from "./DesignRunView";
import type { Run, Request } from "@/types";

const updateRequest = vi.fn();
const executeRequest = vi.fn();

vi.mock("@/hooks/useEngine", () => ({
	useEngine: () => ({ executeRequest }),
}));

// The live request behind the run. `null` is the "request was deleted" case.
let liveRequest: Request | null = null;
/*
 * Whether the lookup is still in flight. This is the distinction the view has
 * to make: `undefined` data means "deleted" only once the query has settled,
 * and there is no `GET /requests/:id` - the lookup fetches every collection's
 * list and scans, so on a cold cache it is genuinely slow.
 */
let isLoadingRequest = false;

vi.mock("@/queries", async () => {
	const actual = await vi.importActual<typeof import("@/queries")>("@/queries");
	return {
		...actual,
		useRequestQuery: () => ({
			data: liveRequest ?? undefined,
			isLoading: isLoadingRequest,
		}),
		useCollectionAncestors: () => [],
		useUpdateRequestMutation: () => ({ mutateAsync: updateRequest, isPending: false }),
	};
});

// Monaco does not run under jsdom. Rendered as text so the Raw tab's contents
// can be read - a textarea would hide them from `getByText`.
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: ({ value }: { value: string }) => <pre data-testid="code">{value}</pre>,
}));

function designRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_000_300,
		requestId: "req_1",
		environmentId: null,
		configSnapshot: {
			method: "POST",
			url: "https://api.example.test/users?page=2",
			headers: { "X-Plain": "visible" },
			body: { mode: "json", content: '{"a":1}' },
			auth: { mode: "bearer" },
			preRequestScripts: [
				{ origin: "collection", id: "col_1", name: "API", script: "const t = 1;" },
				{ origin: "request", id: "req_1", script: "console.log(t);" },
			],
			postRequestScripts: [
				{ origin: "collection", id: "col_1", name: "API", script: "chainAssert();" },
				{ origin: "request", id: "req_1", script: "pm.test('ok', () => {});" },
			],
			followRedirects: false,
			maxRedirects: 3,
			requestId: "req_1",
		},
		result: {
			timestamp: 1_750_000_000_000,
			statusCode: 200,
			statusText: "OK",
			latencyMs: 12,
			trace: {
				dnsMs: 1,
				connectMs: 2,
				request: {
					method: "POST",
					url: "https://api.example.test/users?page=2",
					headers: { "X-Plain": "visible", Authorization: "Bearer SECRET" },
					body: '{"a":1}',
				},
				response: { headers: { "content-type": "application/json" }, body: '{"ok":true}' },
			},
		},
		...overrides,
	} as Run;
}

function renderView(run: Run) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<DesignRunView run={run} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/**
 * Radix activates a tab on `mousedown`, not on `click` - a plain click leaves
 * the panel where it was and every assertion after it reads the old tab.
 */
function selectTab(name: RegExp) {
	fireEvent.mouseDown(screen.getByRole("tab", { name }));
}

/**
 * The request pane's tablist is the first of the two. Needed for Headers, Body
 * and Tests, which name a tab in both panes.
 */
function selectRequestTab(name: RegExp) {
	const requestTabs = screen.getAllByRole("tablist")[0];
	fireEvent.mouseDown(within(requestTabs).getByRole("tab", { name }));
}

beforeEach(() => {
	vi.clearAllMocks();
	isLoadingRequest = false;
	liveRequest = {
		id: "req_1",
		collectionId: "col_1",
		name: "Create user",
		auth: { mode: "bearer", token: "FRESH-TOKEN" },
	} as unknown as Request;
});

describe("DesignRunView - the copy shows the stored exchange", () => {
	it("renders the builder's response tabs", () => {
		renderView(designRun());

		// The full response pane, not the old read-only viewer's two panels.
		// Cookies, Timing and Raw exist only there; Body and Headers name a tab
		// in each pane, so both panes are proved present by the pair.
		expect(screen.getByRole("tab", { name: /^cookies$/i })).toBeTruthy();
		expect(screen.getByRole("tab", { name: /^timing$/i })).toBeTruthy();
		expect(screen.getByRole("tab", { name: /^raw$/i })).toBeTruthy();
		expect(screen.getAllByRole("tab", { name: /^body/i })).toHaveLength(2);
		expect(screen.getAllByRole("tab", { name: /^headers/i })).toHaveLength(2);
	});

	it("marks the response as restored, with its age", () => {
		renderView(designRun());

		// `restoredFrom` drives the chip - without it the pane would present a
		// response from days ago as if it had just arrived.
		expect(screen.getByText(/from run -/i)).toBeTruthy();
	});

	it("shows the body that was sent on the Raw tab", () => {
		renderView(designRun());

		selectTab(/^raw$/i);

		// The old viewer built this from the trace and then rendered a mode that
		// reads only headers, so the sent body appeared nowhere at all.
		const raw = screen.getAllByTestId("code").map((el) => el.textContent ?? "");
		expect(raw.some((text) => text.includes('{"a":1}'))).toBe(true);
		expect(raw.some((text) => text.includes("POST /users?page=2 HTTP/1.1"))).toBe(true);
	});

	it("seeds the editor from the snapshot, not from the live request", () => {
		renderView(designRun());

		const url = screen.getByRole("textbox", { name: /request url/i });
		expect((url as HTMLInputElement).value).toBe("https://api.example.test/users?page=2");
	});

	it("lists the collection scripts the run recorded", () => {
		renderView(designRun());

		selectTab(/^pre-request/i);

		// From the run's own parts. The live chain is mocked empty, so anything
		// listed here can only have come from what was stored.
		expect(screen.getByText(/runs before your own/i)).toBeTruthy();
		expect(screen.getByText("API")).toBeTruthy();
	});
});

describe("DesignRunView - a run that failed", () => {
	it("shows the error view and its hint rather than an empty pane", () => {
		const failed = designRun({
			status: "failed",
			result: {
				timestamp: 1_750_000_000_000,
				statusCode: 0,
				statusText: "Error",
				latencyMs: 0,
				trace: {
					error_type: "DNS_ERROR",
					error_message: "Could not resolve host",
					request: { method: "GET", url: "https://nope.test/", headers: {} },
				},
			},
		});

		renderView(failed);

		expect(screen.getByText(/could not get a response/i)).toBeTruthy();
		// The engine's own words, not a generic "request failed".
		expect(screen.getAllByText(/could not resolve host/i).length).toBeGreaterThan(0);
		// ClientErrorView's per-code tip - the hint the brief asks for.
		expect(screen.getByText(/check if the domain name is correct/i)).toBeTruthy();
		expect(screen.getByText(/DNS_ERROR/)).toBeTruthy();
	});
});

describe("DesignRunView - the copy is detached", () => {
	it("does not save when the URL is edited", () => {
		vi.useFakeTimers();
		try {
			renderView(designRun());

			const url = screen.getByRole("textbox", { name: /request url/i });
			fireEvent.change(url, { target: { value: "https://api.example.test/edited" } });

			// The builder autosaves on a debounce. Run well past it: the point is
			// that no timer was ever armed, because the provider gets no `onSave`.
			vi.advanceTimersByTime(60_000);

			expect(updateRequest).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("can still send, so the copy is editable and runnable", () => {
		renderView(designRun());

		const send = screen.getByRole("button", { name: /^send$/i });
		expect(send).toBeTruthy();
		expect((send as HTMLButtonElement).disabled).toBe(false);
	});
});

describe("DesignRunView - sending it again", () => {
	it("replays the recorded collection parts plus the edited request part", async () => {
		executeRequest.mockResolvedValue({
			status: 200,
			statusText: "OK",
			headers: {},
			body: "{}",
		});

		renderView(designRun());

		fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
		await vi.waitFor(() => expect(executeRequest).toHaveBeenCalled());

		const payload = executeRequest.mock.calls[0][0];

		// As they were recorded, not as the collection reads now.
		expect(payload.preRequestScripts).toEqual([
			{ origin: "collection", id: "col_1", name: "API", script: "const t = 1;" },
			{ origin: "request", script: "console.log(t);" },
		]);
		/*
		 * The post list too. The brief only ever named `preRequestScripts`, so
		 * sending the post list is easy to drop - and dropping it silently
		 * discards the assertions the run was recorded with, which is exactly
		 * the failure a replay is supposed to reproduce.
		 */
		expect(payload.postRequestScripts).toEqual([
			{ origin: "collection", id: "col_1", name: "API", script: "chainAssert();" },
			{ origin: "request", script: "pm.test('ok', () => {});" },
		]);
		// Filed under the same request, so the new run lands beside the old one.
		expect(payload.requestId).toBe("req_1");
	});
});

describe("DesignRunView - saving back to the request", () => {
	it("offers Save while the request still exists", () => {
		renderView(designRun());

		expect(screen.getByRole("button", { name: /save this run to the request/i })).toBeTruthy();
	});

	it("hides Save when the request has been deleted", () => {
		// Nothing to write back to. Absent rather than disabled - a disabled
		// button invites a hunt for the condition that would enable it.
		liveRequest = null;

		renderView(designRun());

		expect(screen.queryByRole("button", { name: /save this run to the request/i })).toBeNull();
	});

	it("replays the recorded Authorization when the request is gone", async () => {
		liveRequest = null;
		executeRequest.mockResolvedValue({
			status: 200,
			statusText: "OK",
			headers: {},
			body: "{}",
		});

		renderView(designRun());

		fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
		await vi.waitFor(() => expect(executeRequest).toHaveBeenCalled());

		// The seed put the wire headers in the editor, so the old token goes out
		// as-is and the run is replayed exactly as it ran. A 401 is then a true
		// answer about replaying it, and the header is editable to fix that.
		expect(executeRequest.mock.calls[0][0].headers.Authorization).toBe("Bearer SECRET");
		expect(executeRequest.mock.calls[0][0].auth).toBeUndefined();
	});
});

describe("DesignRunView - the request lookup has to settle first", () => {
	/*
	 * The regression this pins: `seedFromRun` reads a falsy `liveRequest` as
	 * "the request was deleted", and a query in flight is also falsy. Seeding
	 * before it settles therefore produced the deleted-request seed - trace
	 * headers carrying the recorded `Authorization`, and `authType: "none"` -
	 * and the provider never corrected it, because its reset effect keys on
	 * `initialRequest?.id`, which is null for every detached copy both before
	 * and after. There is no `GET /requests/:id`, so a cold cache means the
	 * lookup scans every collection's list: this window is real, not theoretical.
	 */
	it("seeds from the snapshot and the request's auth once the lookup resolves", async () => {
		executeRequest.mockResolvedValue({
			status: 200,
			statusText: "OK",
			headers: {},
			body: "{}",
		});

		/*
		 * One run object and one client across both renders, so the *only*
		 * thing that changes is the query's state.
		 *
		 * This is load-bearing. Handing `rerender` a fresh `designRun()` gives
		 * the provider a new `initialResponse` identity, which re-fires its
		 * reset effect and re-seeds the builder - so the pane recovers by a
		 * route that does not exist in production, where `run` comes from
		 * `useRunQuery` and TanStack keeps the reference stable. With a fresh
		 * object this test passed even with the settled-state gate removed:
		 * four of its five assertions were inert, including the two that read
		 * most directly on the bug.
		 */
		const theRun = designRun();
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		// A new element each time (React can bail out on an identical one), but
		// the same `run` and `client` references inside it.
		const tree = () => (
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<DesignRunView run={theRun} />
				</TooltipProvider>
			</QueryClientProvider>
		);

		// First render: cold cache, still looking.
		isLoadingRequest = true;
		liveRequest = null;
		const { rerender } = render(tree());

		// Nothing is seeded yet - the builder must not mount on a guess.
		expect(screen.queryByRole("textbox", { name: /request url/i })).toBeNull();

		// The lookup lands.
		isLoadingRequest = false;
		liveRequest = {
			id: "req_1",
			collectionId: "col_1",
			name: "Create user",
			auth: { mode: "bearer", token: "FRESH-TOKEN" },
		} as unknown as Request;
		rerender(tree());

		// The editor shows the *snapshot* headers, which carry no credential -
		// not the wire headers, which carry the recorded bearer token.
		selectRequestTab(/^headers/i);
		expect(screen.getByDisplayValue("X-Plain")).toBeTruthy();
		expect(screen.queryByDisplayValue("Authorization")).toBeNull();
		expect(screen.queryByDisplayValue("Bearer SECRET")).toBeNull();

		// And auth resolves fresh from the saved request rather than riding along
		// inside a header, which is what the spec promises.
		fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
		await vi.waitFor(() => expect(executeRequest).toHaveBeenCalled());

		const payload = executeRequest.mock.calls[0][0];
		expect(payload.auth).toEqual({ mode: "bearer", token: "FRESH-TOKEN" });
		expect(payload.headers.Authorization).toBeUndefined();
	});
});

describe("DesignRunView - a run recorded before script parts existed", () => {
	/*
	 * Every design run in a user's history on upgrade day. `seedFromRun` cannot
	 * fill the editor for one, because there is no part list to take the
	 * request's own half from - so the script text exists only on
	 * `seed.legacyPreScript`. While nothing read that field the pane showed an
	 * empty editor with no notice, and the replay sent no script at all.
	 */
	const GLUED_PRE = "collectionSetup();\n\nrequestOwnPart();";
	const GLUED_POST = "chainAssert();\n\nownAssert();";

	function legacyRun() {
		return designRun({
			configSnapshot: {
				method: "POST",
				url: "https://api.example.test/users?page=2",
				headers: { "X-Plain": "visible" },
				preRequestScript: GLUED_PRE,
				postRequestScript: GLUED_POST,
				requestId: "req_1",
			},
		} as Partial<Run>);
	}

	it("shows the whole recorded script with a note that its parts cannot be split", () => {
		renderView(legacyRun());

		selectRequestTab(/^pre-request/i);

		expect(screen.getByText(/cannot be separated/i)).toBeTruthy();
		// The text itself, not merely an acknowledgement that some exists.
		expect(screen.getByText(/collectionSetup/)).toBeTruthy();
		expect(screen.getByText(/requestOwnPart/)).toBeTruthy();
	});

	it("shows the recorded test script on the Tests tab too", () => {
		renderView(legacyRun());

		selectRequestTab(/^tests$/i);

		expect(screen.getByText(/ownAssert/)).toBeTruthy();
	});

	it("replays the recorded script rather than nothing", async () => {
		executeRequest.mockResolvedValue({
			status: 200,
			statusText: "OK",
			headers: {},
			body: "{}",
		});

		renderView(legacyRun());

		fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
		await vi.waitFor(() => expect(executeRequest).toHaveBeenCalled());

		const payload = executeRequest.mock.calls[0][0];
		expect(payload.preRequestScripts).toEqual([{ origin: "request", script: GLUED_PRE }]);
		expect(payload.postRequestScripts).toEqual([{ origin: "request", script: GLUED_POST }]);
	});

	it("leaves the notice out for a run that has proper script parts", () => {
		renderView(designRun());

		selectRequestTab(/^pre-request/i);

		expect(screen.queryByText(/cannot be separated/i)).toBeNull();
	});
});

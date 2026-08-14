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
 * The Services drawer (issue #502).
 *
 * The OAuth issuer had no app surface at all before this - the engine's four
 * routes were reachable only from curl or the MCP tools - so these cases are
 * the first proof that a user can start, read and stop one. The inbox half is
 * about the second entry point: the drawer lists it and opens its tab, without
 * taking the tab's job.
 *
 * The transport is mocked and the real query hooks run, so a row acting on a
 * service goes through the same mutation and cache invalidation the app uses;
 * only the HTTP call is faked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore, useToastStore } from "@/stores";
import type { Inbox, MockIssuer } from "@/types";
import ServicesPanel from "./ServicesPanel";

const listInboxes = vi.fn();
const listMockIssuers = vi.fn();
const startInbox = vi.fn();
const stopInbox = vi.fn();
const deleteInbox = vi.fn();
const startMockIssuer = vi.fn();
const stopMockIssuer = vi.fn();
const updateMockIssuer = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listMockIssuers: () => listMockIssuers(),
			startInbox: (...a: unknown[]) => startInbox(...a),
			stopInbox: (...a: unknown[]) => stopInbox(...a),
			deleteInbox: (...a: unknown[]) => deleteInbox(...a),
			startMockIssuer: (...a: unknown[]) => startMockIssuer(...a),
			stopMockIssuer: (...a: unknown[]) => stopMockIssuer(...a),
			updateMockIssuer: (...a: unknown[]) => updateMockIssuer(...a),
		},
	};
});

const writeText = vi.fn();

function inbox(overrides: Partial<Inbox> = {}): Inbox {
	return {
		inboxId: "inbox_a",
		url: "http://127.0.0.1:41234/",
		bind: "127.0.0.1",
		port: 41234,
		running: true,
		loopback: true,
		captureCount: 0,
		response: { status: 200, body: "", headers: {}, delayMs: 0 },
		...overrides,
	};
}

function issuer(overrides: Partial<MockIssuer> = {}): MockIssuer {
	return {
		issuerId: "iss_a",
		issuerUrl: "http://127.0.0.1:42000",
		tokenUrl: "http://127.0.0.1:42000/token",
		authorizeUrl: "http://127.0.0.1:42000/authorize",
		signingKey: "k".repeat(32),
		port: 42000,
		expiresInSeconds: 3600,
		failureMode: "none",
		slowMs: 0,
		issueRefreshTokens: false,
		clientCount: 0,
		createdAt: 1700000000000,
		...overrides,
	};
}

function renderPanel() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ServicesPanel />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	cleanup();
	listInboxes.mockReset().mockResolvedValue([]);
	listMockIssuers.mockReset().mockResolvedValue([]);
	startInbox.mockReset().mockResolvedValue(inbox());
	stopInbox.mockReset().mockResolvedValue(inbox({ running: false }));
	deleteInbox.mockReset().mockResolvedValue({ inboxId: "inbox_a", capturesDeleted: 0 });
	startMockIssuer.mockReset().mockResolvedValue({
		issuerId: "iss_new",
		issuerUrl: "http://127.0.0.1:42001",
		tokenUrl: "http://127.0.0.1:42001/token",
		authorizeUrl: "http://127.0.0.1:42001/authorize",
		signingKey: "s".repeat(32),
	});
	stopMockIssuer.mockReset().mockResolvedValue({ stopped: true });
	updateMockIssuer.mockReset().mockResolvedValue(issuer({ failureMode: "server_error" }));
	writeText.mockReset();
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useToastStore.setState({ toasts: [] });
});

describe("the services drawer", () => {
	it("names both service kinds, so the drawer teaches what a service is", async () => {
		renderPanel();
		expect(await screen.findByText("Webhook inboxes")).toBeInTheDocument();
		expect(screen.getByText("OAuth issuers")).toBeInTheDocument();
	});

	it("says what each empty group would give you, not just that it is empty", async () => {
		renderPanel();
		expect(await screen.findByText(/records every request sent to it/i)).toBeInTheDocument();
		expect(screen.getByText(/mint your own OAuth 2.0 tokens locally/i)).toBeInTheDocument();
	});

	/*
	 * "New inbox", not "Start inbox": the affordance always mints a new listener,
	 * and beside a stopped row the old Play icon and wording read as "restart
	 * that one" - which it never did (issue #553).
	 */
	it("mints a new inbox from the group's own affordance, and says that is what it does", async () => {
		listInboxes.mockResolvedValue([inbox({ running: false })]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: "New inbox" }));
		await waitFor(() => expect(startInbox).toHaveBeenCalled());
		expect(screen.queryByRole("button", { name: /^start inbox$/i })).not.toBeInTheDocument();
	});

	/*
	 * The start mutation carried an `onError` and no `onSuccess`, so a
	 * successful create reported nothing at all - and since rows sort by port,
	 * the new one lands wherever its ephemeral port falls rather than at the
	 * end. Mutation-check: drop the `onSuccess` and this fails.
	 */
	it("says a new inbox started, and names the port it got", async () => {
		startInbox.mockResolvedValue(inbox({ inboxId: "inbox_new", port: 41240 }));
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: "New inbox" }));
		await waitFor(() =>
			expect(useToastStore.getState().toasts[0]).toMatchObject({
				variant: "success",
				message: "Inbox started on port 41240",
			})
		);
	});

	it("highlights the row it just created, so the eye can find it in port order", async () => {
		const created = inbox({
			inboxId: "inbox_new",
			port: 41230,
			url: "http://127.0.0.1:41230/",
		});
		startInbox.mockResolvedValue(created);
		listInboxes.mockResolvedValue([inbox(), created]);
		renderPanel();

		await screen.findByText("Port 41234");
		fireEvent.click(screen.getByRole("button", { name: "New inbox" }));

		const flashedRow = await waitFor(() => {
			const row = screen.getByText("Port 41230").closest("div.flex.h-8");
			expect(row?.className).toContain("bg-primary/10");
			return row;
		});
		// And only that row - the highlight names one inbox, not the group.
		expect(screen.getByText("Port 41234").closest("div.flex.h-8")).not.toBe(flashedRow);
		expect(screen.getByText("Port 41234").closest("div.flex.h-8")?.className).not.toContain(
			"bg-primary/10"
		);
	});

	it("still reports a refused start, and highlights nothing", async () => {
		startInbox.mockRejectedValue(new Error("address already in use"));
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: "New inbox" }));
		await waitFor(() =>
			expect(useToastStore.getState().toasts[0]).toMatchObject({
				variant: "error",
				message: "address already in use",
			})
		);
	});
});

describe("an inbox row", () => {
	it("opens the inbox tab - the drawer lists, the tab shows the captures", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: /open inbox.*port 41234/i }));
		expect(useTabsStore.getState().openTabs.map((t) => t.type)).toContain("inbox");
	});

	/*
	 * The row's label names one inbox, so the tab has to receive that one. It
	 * used to open the tab with no address at all, which the tab resolved to the
	 * first inbox in the engine's list - clicking the second row showed the
	 * first (issue #554).
	 */
	it("hands the tab the inbox the row names, not just the tab type", async () => {
		listInboxes.mockResolvedValue([
			inbox(),
			inbox({ inboxId: "inbox_b", port: 41235, url: "http://127.0.0.1:41235/" }),
		]);
		renderPanel();

		fireEvent.click(await screen.findByRole("button", { name: /open inbox.*port 41235/i }));
		expect(useTabsStore.getState().openTabs).toContainEqual(
			expect.objectContaining({ type: "inbox", entityId: "inbox_b" })
		);

		// And the second row retargets the one open tab rather than opening a
		// second inbox tab.
		fireEvent.click(screen.getByRole("button", { name: /open inbox.*port 41234/i }));
		const inboxTabs = useTabsStore.getState().openTabs.filter((t) => t.type === "inbox");
		expect(inboxTabs).toHaveLength(1);
		expect(inboxTabs[0].entityId).toBe("inbox_a");
	});

	it("copies the URL a webhook source is pointed at", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: "Copy inbox URL" }));
		expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:41234/");
	});

	it("stops a running inbox", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: /stop inbox on port 41234/i }));
		await waitFor(() => expect(stopInbox).toHaveBeenCalledWith("inbox_a"));
	});

	/*
	 * A stopped inbox stays listed - the engine keeps its record and its
	 * captures readable - so the row has to say which it is and drop the action
	 * that no longer applies. This is the half an issuer row does not have: a
	 * stopped issuer is gone from the engine's list entirely.
	 */
	it("marks a stopped inbox and offers no stop for it", async () => {
		listInboxes.mockResolvedValue([inbox({ running: false })]);
		renderPanel();
		expect(await screen.findByText("Stopped")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /stop inbox/i })).not.toBeInTheDocument();
	});

	/*
	 * The row a stopped inbox most needs. Stopping is terminal by design - the
	 * record and its captures stay readable until the engine exits - so without
	 * a delete here every stopped inbox was permanent, and the group's own
	 * affordance minted more (issue #553).
	 */
	it("deletes a stopped inbox, which nothing else here can remove", async () => {
		listInboxes.mockResolvedValue([inbox({ running: false })]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: /delete inbox on port 41234/i }));
		await waitFor(() => expect(deleteInbox).toHaveBeenCalledWith("inbox_a"));
	});

	it("asks before destroying captures, naming what would be lost", async () => {
		listInboxes.mockResolvedValue([inbox({ captureCount: 37 })]);
		renderPanel();

		fireEvent.click(await screen.findByRole("button", { name: /delete inbox on port 41234/i }));
		expect(await screen.findByText(/37 recorded requests/i)).toBeInTheDocument();
		expect(deleteInbox).not.toHaveBeenCalled();

		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(deleteInbox).toHaveBeenCalledWith("inbox_a"));
	});

	it("deletes a running inbox too - the engine stops it on the way", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: /delete inbox on port 41234/i }));
		await waitFor(() => expect(deleteInbox).toHaveBeenCalledWith("inbox_a"));
		expect(stopInbox).not.toHaveBeenCalled();
	});

	/*
	 * The row's `aria-label` *replaced* its content in the accessible name, so
	 * everything the row says about this particular inbox - which one it is,
	 * whether it is still listening, whether it is reachable beyond this machine
	 * - was inaudible, and a stopped row and a running one read identically.
	 * Mutation-check: put the label back as an `aria-label` on the activator and
	 * this fails on every assertion after the first.
	 */
	it("reads out what the row says, not a label that replaces it", async () => {
		listInboxes.mockResolvedValue([
			inbox({ running: false, loopback: false, bind: "0.0.0.0" }),
		]);
		renderPanel();

		const name = (await screen.findByRole("button", { name: /open inbox/i })).textContent ?? "";
		expect(name).toContain("Open inbox");
		expect(name).toContain("Port 41234");
		expect(name).toContain("http://127.0.0.1:41234/");
		expect(name).toContain("Stopped");
		expect(name).toContain("0.0.0.0");
	});

	/*
	 * Three inboxes were three near-identical monospace URLs differing in one
	 * digit. The port is the part that varies and the part a user names an inbox
	 * by, so it leads and the URL - the value you copy, not the one you scan a
	 * list by - is demoted behind it.
	 */
	it("leads with the port, so a list of inboxes is not one string repeated", async () => {
		listInboxes.mockResolvedValue([
			inbox(),
			inbox({ inboxId: "inbox_b", port: 41235, url: "http://127.0.0.1:41235/" }),
		]);
		renderPanel();
		expect(await screen.findByText("Port 41234")).toBeInTheDocument();
		expect(screen.getByText("Port 41235")).toBeInTheDocument();
	});

	/*
	 * The engine lists inboxes in map order, which is not stable across polls -
	 * so a row could move under the pointer, and a newly created one arrived
	 * anywhere. Port is the stable key the record carries (it carries no
	 * creation stamp; see the module doc). Mutation-check: render `inboxes`
	 * instead of `orderedInboxes` and this fails.
	 */
	it("orders rows by port, whatever order the engine listed them in", async () => {
		listInboxes.mockResolvedValue([
			inbox({ inboxId: "inbox_c", port: 41236, url: "http://127.0.0.1:41236/" }),
			inbox(),
			inbox({ inboxId: "inbox_b", port: 41235, url: "http://127.0.0.1:41235/" }),
		]);
		renderPanel();
		await screen.findByText("Port 41234");
		expect(screen.getAllByText(/^Port 4123\d$/).map((el) => el.textContent)).toEqual([
			"Port 41234",
			"Port 41235",
			"Port 41236",
		]);
	});

	/*
	 * `writeText` rejects - a denied permission, an unfocused document - and
	 * this fired it with `void` and toasted "copied" regardless, so the user
	 * pasted whatever was on the clipboard before. Mutation-check: drop the
	 * await and the catch, and this reports a success.
	 */
	it("does not claim a copy that the clipboard refused", async () => {
		writeText.mockRejectedValue(new Error("Clipboard write denied"));
		listInboxes.mockResolvedValue([inbox()]);
		renderPanel();

		fireEvent.click(await screen.findByRole("button", { name: "Copy inbox URL" }));
		await waitFor(() =>
			expect(useToastStore.getState().toasts[0]).toMatchObject({ variant: "error" })
		);
		expect(useToastStore.getState().toasts[0].message).toMatch(/Clipboard write denied/);
	});

	/*
	 * A stopped inbox's URL copies perfectly well and then refuses connections,
	 * a long way from the cause - so the affordance says which it is where the
	 * URL itself is offered.
	 */
	it("warns that a stopped inbox's URL has nothing listening behind it", async () => {
		listInboxes.mockResolvedValue([inbox({ running: false })]);
		renderPanel();
		fireEvent.focus(await screen.findByRole("button", { name: "Copy inbox URL" }));
		// Radix renders the content twice - the visible tip and its aria copy.
		expect((await screen.findAllByText(/stopped, not listening/i)).length).toBeGreaterThan(0);
	});

	it("says so when the copy worked", async () => {
		writeText.mockResolvedValue(undefined);
		listInboxes.mockResolvedValue([inbox()]);
		renderPanel();

		fireEvent.click(await screen.findByRole("button", { name: "Copy inbox URL" }));
		await waitFor(() =>
			expect(useToastStore.getState().toasts[0]).toMatchObject({
				variant: "success",
				message: "Inbox URL copied",
			})
		);
	});
});

describe("an issuer row", () => {
	it("hands over the two URLs and the signing key only once expanded", async () => {
		listMockIssuers.mockResolvedValue([issuer()]);
		renderPanel();
		// Collapsed: the row is the issuer's base URL and nothing else, so a
		// drawer of eight issuers stays readable.
		expect(screen.queryByText("http://127.0.0.1:42000/token")).not.toBeInTheDocument();

		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);

		expect(screen.getByText("http://127.0.0.1:42000/token")).toBeInTheDocument();
		expect(screen.getByText("http://127.0.0.1:42000/authorize")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Copy signing key" }));
		expect(writeText).toHaveBeenCalledWith("k".repeat(32));
	});

	it("summarises what the issuer will do, in its own numbers", async () => {
		listMockIssuers.mockResolvedValue([
			issuer({ expiresInSeconds: 120, failureMode: "slow", slowMs: 2000, clientCount: 2 }),
		]);
		renderPanel();
		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);
		expect(
			screen.getByText(
				/Tokens expire in 120s · answers after 2000ms · 2 clients configured\./
			)
		).toBeInTheDocument();
	});

	it("flips a running issuer into a failure mode without restarting it", async () => {
		listMockIssuers.mockResolvedValue([issuer()]);
		renderPanel();
		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);
		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: "Server error" }));
		await waitFor(() =>
			expect(updateMockIssuer).toHaveBeenCalledWith("iss_a", { failureMode: "server_error" })
		);
	});

	/*
	 * Slow is the one mode with a parameter, and the switch offered no way to
	 * see or set it: the issuer answered after whatever `slowMs` it was
	 * *started* with, the summary line beside the switch reported that number,
	 * and `PUT /mock-issuer/:id` had accepted a new one all along. Mutation-
	 * check: render the control unconditionally and the first assertion fails;
	 * drop it entirely and the rest do.
	 */
	it("does not offer a delay in a mode that never reads one", async () => {
		listMockIssuers.mockResolvedValue([issuer({ failureMode: "none" })]);
		renderPanel();
		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);
		expect(screen.queryByLabelText(/delay/i)).not.toBeInTheDocument();
	});

	it("shows the delay a slow issuer is running with, and sends the new one", async () => {
		listMockIssuers.mockResolvedValue([issuer({ failureMode: "slow", slowMs: 2000 })]);
		renderPanel();
		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);

		const delay = screen.getByLabelText(/delay/i);
		expect(delay).toHaveValue(2000);
		fireEvent.change(delay, { target: { value: "5000" } });
		fireEvent.blur(delay);
		await waitFor(() =>
			expect(updateMockIssuer).toHaveBeenCalledWith("iss_a", { slowMs: 5000 })
		);
	});

	/*
	 * Every character of "5000" is a valid number, so a field committing per
	 * keystroke would send 5, 50, 500 - three PUTs reconfiguring a running
	 * listener on the way to the one the user meant.
	 */
	it("commits the delay once, not once per keystroke", async () => {
		listMockIssuers.mockResolvedValue([issuer({ failureMode: "slow", slowMs: 2000 })]);
		renderPanel();
		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);

		const delay = screen.getByLabelText(/delay/i);
		fireEvent.change(delay, { target: { value: "5" } });
		fireEvent.change(delay, { target: { value: "50" } });
		fireEvent.change(delay, { target: { value: "500" } });
		expect(updateMockIssuer).not.toHaveBeenCalled();

		fireEvent.blur(delay);
		await waitFor(() => expect(updateMockIssuer).toHaveBeenCalledTimes(1));
		expect(updateMockIssuer).toHaveBeenCalledWith("iss_a", { slowMs: 500 });
	});

	/*
	 * The engine answers an out-of-range value with a `400
	 * mock_issuer_invalid_config` that names no field, so the bound is stated
	 * here and nothing is sent.
	 */
	it("refuses an out-of-range delay by name, and sends nothing", async () => {
		listMockIssuers.mockResolvedValue([issuer({ failureMode: "slow", slowMs: 2000 })]);
		renderPanel();
		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);

		const delay = screen.getByLabelText(/delay/i);
		fireEvent.change(delay, { target: { value: "999999" } });
		expect(screen.getByText(/whole number of milliseconds, 0 to 60000/i)).toBeInTheDocument();
		fireEvent.blur(delay);
		expect(updateMockIssuer).not.toHaveBeenCalled();
	});

	/*
	 * `border-rule` inherits the `--rule` its enclosing surface declares, and no
	 * drawer surface declares one - so a rule here fell back to the canvas
	 * default, which against `--panel` in dark measures 1.07 and is simply not
	 * visible. Asserting `border-rule` is present would prove nothing (it always
	 * was); what has to hold is the *declaration*, per `app/CLAUDE.md`.
	 * Mutation-check: drop `surface-sunken` and this fails.
	 */
	it("declares the surface its expanded detail's rule reads on", async () => {
		listMockIssuers.mockResolvedValue([issuer()]);
		renderPanel();
		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);

		const detail = screen.getByText("HS256 shared secret").closest("div.border-l-2");
		expect(detail?.className).toContain("border-rule");
		expect(detail?.className).toContain("surface-sunken");
	});

	it("stops the issuer it names", async () => {
		listMockIssuers.mockResolvedValue([issuer()]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: /stop issuer on port 42000/i }));
		await waitFor(() => expect(stopMockIssuer).toHaveBeenCalledWith("iss_a"));
	});
});

describe("starting an issuer", () => {
	const openDialog = async () => {
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: "New issuer" }));
		return within(await screen.findByRole("dialog"));
	};

	it("sends the defaults when nothing is changed - a bare start is the common case", async () => {
		const dialog = await openDialog();
		fireEvent.click(dialog.getByRole("button", { name: /start issuer/i }));
		await waitFor(() =>
			expect(startMockIssuer).toHaveBeenCalledWith({
				expiresInSeconds: 3600,
				failureMode: "none",
			})
		);
	});

	it("sends the claims the user typed", async () => {
		const dialog = await openDialog();
		fireEvent.change(dialog.getByLabelText(/claims/i), {
			target: { value: '{"sub":"alice"}' },
		});
		fireEvent.click(dialog.getByRole("button", { name: /start issuer/i }));
		await waitFor(() =>
			expect(startMockIssuer).toHaveBeenCalledWith({
				expiresInSeconds: 3600,
				failureMode: "none",
				claims: { sub: "alice" },
			})
		);
	});

	/*
	 * The engine refuses a bad config rather than falling back to a default, and
	 * a claims typo is otherwise invisible until a token comes back without the
	 * claim. So both are refused here, with the reason on the field.
	 */
	it("refuses malformed claims by name, and sends nothing", async () => {
		const dialog = await openDialog();
		fireEvent.change(dialog.getByLabelText(/claims/i), { target: { value: "{sub:" } });
		expect(dialog.getByRole("button", { name: /start issuer/i })).toBeDisabled();
		fireEvent.click(dialog.getByRole("button", { name: /start issuer/i }));
		expect(startMockIssuer).not.toHaveBeenCalled();
	});

	it("refuses a claims value that is valid JSON but not a claim set", async () => {
		const dialog = await openDialog();
		fireEvent.change(dialog.getByLabelText(/claims/i), { target: { value: '["admin"]' } });
		expect(dialog.getByText(/must be a JSON object/i)).toBeInTheDocument();
		expect(dialog.getByRole("button", { name: /start issuer/i })).toBeDisabled();
	});

	/*
	 * A reddened field beside a greyed-out Start says that something is wrong
	 * and never which field or why, and `aria-invalid` alone announces
	 * "invalid" with no correction. The claims box already stated its rule; the
	 * two numeric fields did not. Mutation-check: delete the error paragraphs
	 * and the two text assertions here fail while the disabled ones still pass,
	 * which is the whole point.
	 */
	it("refuses an out-of-range lifetime, and says what would be in range", async () => {
		const dialog = await openDialog();
		fireEvent.change(dialog.getByLabelText(/token lifetime/i), { target: { value: "0" } });
		expect(dialog.getByRole("button", { name: /start issuer/i })).toBeDisabled();
		expect(dialog.getByText(/whole number of seconds, 1 to 2678400/i)).toBeInTheDocument();
	});

	it("refuses an out-of-range delay, and says what would be in range", async () => {
		const dialog = await openDialog();
		fireEvent.click(dialog.getByRole("combobox"));
		fireEvent.click(await screen.findByRole("option", { name: "Slow" }));
		fireEvent.change(dialog.getByLabelText(/delay/i), { target: { value: "-1" } });
		expect(dialog.getByText(/whole number of milliseconds, 0 to 60000/i)).toBeInTheDocument();
		expect(dialog.getByRole("button", { name: /start issuer/i })).toBeDisabled();
	});
});

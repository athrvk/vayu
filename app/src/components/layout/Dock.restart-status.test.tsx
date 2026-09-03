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
 * One strip cannot say two things about the same engine (#1227).
 *
 * A restart the user asked for kills the daemon and spawns a fresh one that
 * repeats the whole cold start, with the port down for all of it. The health
 * poll kept classifying that silence as an engine that had answered and
 * stopped - so the Dock painted "Disconnected" and a raw transport string
 * beside its own "Restarting…" spinner, and the louder of the two described a
 * failure the user had just requested.
 *
 * Both halves of the fix meet here, which is why this is a rendered end-to-end
 * case rather than another store assertion: `useEngineRestart` opens the start
 * window, `useHealthQuery` classifies the failed poll against it, and the Dock
 * is what the user actually reads. The second case is the mutation check
 * pointing the other way - an engine that drops on its own must still owe a
 * reason, so a window that were simply always open would redden it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const getHealth = vi.fn();
// Only the health call is stubbed. The Dock's three service lists fail against
// no engine, which is the state these cases want anyway: nothing is listening.
vi.mock("@/services/api", () => ({ apiService: { getHealth: () => getHealth() } }));

import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { Dock } from "./Dock";
import { useHealthQuery } from "@/queries/health";
import { queryKeys } from "@/queries/keys";
import { useEngineStore } from "@/stores";

// The Dock prints the app version, which Vite `define`s at build time.
vi.stubGlobal("__VAYU_VERSION__", "0.0.0-test");

const restartEngine = vi.fn();

/** What `App` does: mounts the poll once, above the strip that renders it. */
function HealthPoll() {
	useHealthQuery();
	return null;
}

function makeClient() {
	// `retry` belongs to the hook; only the delay between its attempts can be
	// flattened here, and the default backoff outlasts `waitFor`.
	return new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
}

function renderDock(client: QueryClient) {
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<HealthPoll />
				<Dock />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const restartButton = () => screen.getByRole("button", { name: /Restart pending/i });

/** The affordance `starting` must not grow: the focusable error tooltip. */
const reasonAffordance = () => document.querySelector("[tabindex='0'] .lucide-info");

beforeEach(() => {
	cleanup();
	vi.clearAllMocks();
	getHealth.mockReset();
	useEngineStore.setState({
		engineStatus: "starting",
		engineError: null,
		engineStartWindow: null,
		pendingRestart: false,
		restartRequiredKeys: [],
	});
	restartEngine.mockResolvedValue({ success: true });
	(window as unknown as { electronAPI: unknown }).electronAPI = { restartEngine };
});

describe("the Dock during a restart the user asked for", () => {
	it("says Starting…, not Disconnected, while the engine is coming back", async () => {
		getHealth.mockResolvedValueOnce({ status: "ok", version: "1.0.0", workers: 8 });
		// Left pending on purpose: this is the window the user is looking at
		// *during* the round trip, which is when the port is down.
		restartEngine.mockReturnValue(new Promise(() => {}));
		useEngineStore.getState().addRestartRequiredKey("dbCacheSize");

		const client = makeClient();
		renderDock(client);
		await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());

		getHealth.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9876"));
		fireEvent.click(restartButton());
		await waitFor(() => expect(restartEngine).toHaveBeenCalledTimes(1));

		// The poll the restart's own invalidate would have run 1.5s later; nothing
		// here depends on that wait, only on the port being down when it lands.
		await act(async () => {
			await client.refetchQueries();
		});

		await waitFor(() => expect(screen.getByText("Starting…")).toBeTruthy());
		expect(screen.queryByText("Disconnected")).toBeNull();
		expect(reasonAffordance()).toBeNull();
		// The spinner the contradiction stood beside is still up.
		expect(screen.getByRole("button", { name: /Restarting…/i })).toBeTruthy();
	});

	it("is not talked out of the window by an answer from the engine it just killed", async () => {
		// The poll can have a question already out when the click lands, and that
		// answer describes the process the restart is about to kill. Letting it
		// close the window opened a moment earlier would put the next failed poll
		// back on the unreachable path - the exact contradiction this file exists
		// to prevent, reached the long way round.
		getHealth.mockResolvedValueOnce({ status: "ok", version: "1.0.0", workers: 8 });
		restartEngine.mockReturnValue(new Promise(() => {}));
		useEngineStore.getState().addRestartRequiredKey("dbCacheSize");

		const client = makeClient();
		renderDock(client);
		await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());

		// A poll in flight against an engine that is still alive. Held open by
		// hand: the interleaving is the whole case, so it cannot be left to a
		// timer.
		let answerTheOldEngine!: (value: unknown) => void;
		getHealth.mockReturnValue(
			new Promise((resolve) => {
				answerTheOldEngine = resolve;
			})
		);
		const inFlight = client.refetchQueries({ queryKey: queryKeys.health.status() });
		// The precondition, asserted rather than assumed: a case whose poll had
		// already settled before the click would prove nothing and still pass.
		expect(client.getQueryState(queryKeys.health.status())?.fetchStatus).toBe("fetching");

		fireEvent.click(restartButton());
		await waitFor(() => expect(restartEngine).toHaveBeenCalledTimes(1));
		expect(useEngineStore.getState().engineStartWindow).not.toBeNull();

		await act(async () => {
			// A different payload, so structural sharing cannot hide the update.
			answerTheOldEngine({ status: "ok", version: "1.0.0", workers: 9 });
			await inFlight;
		});

		getHealth.mockImplementation(() =>
			Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:9876"))
		);
		await act(async () => {
			await client.refetchQueries({ queryKey: queryKeys.health.status() });
		});

		await waitFor(() => expect(screen.getByText("Starting…")).toBeTruthy());
		expect(screen.queryByText("Disconnected")).toBeNull();
	});

	it("does not sit on Starting… over an engine nobody is bringing up", async () => {
		// A restart the main process reports as failed leaves nothing coming up,
		// so the strip owes the user its reason again on the next failed poll.
		getHealth.mockResolvedValueOnce({ status: "ok", version: "1.0.0", workers: 8 });
		restartEngine.mockResolvedValue({ success: false, error: "engine did not come back" });
		useEngineStore.getState().addRestartRequiredKey("dbCacheSize");

		const client = makeClient();
		renderDock(client);
		await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());

		getHealth.mockImplementation(() => Promise.reject(new Error("socket hang up")));
		fireEvent.click(restartButton());
		await waitFor(() => expect(useEngineStore.getState().engineStartWindow).toBeNull());

		await act(async () => {
			await client.refetchQueries({ queryKey: queryKeys.health.status() });
		});

		await waitFor(() => expect(screen.getByText("Disconnected")).toBeTruthy());
		expect(screen.queryByText("Starting…")).toBeNull();
		expect(reasonAffordance()).not.toBeNull();
	});

	it("still says Disconnected, with its reason, when the engine drops on its own", async () => {
		// No restart, so no window: the same failed poll has to read the other way.
		getHealth.mockResolvedValueOnce({ status: "ok", version: "1.0.0", workers: 8 });

		const client = makeClient();
		renderDock(client);
		await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());

		getHealth.mockRejectedValue(new Error("socket hang up"));
		await act(async () => {
			await client.refetchQueries();
		});

		await waitFor(() => expect(screen.getByText("Disconnected")).toBeTruthy());
		expect(useEngineStore.getState().engineError).toContain("socket hang up");
		expect(reasonAffordance()).not.toBeNull();
	});
});

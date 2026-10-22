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
 * Settings, General's "Start at login" card (#2098).
 *
 * The value lives in the OS: the card reads it through the preload bridge on
 * mount and again after each write, and never keeps its own copy. The card
 * renders its anchor in every state, because Settings search scrolls to it and
 * `app-settings.drift.test.tsx` renders the panel with no bridge at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui";
import { useToastStore } from "@/stores";
import type { LoginItemInfo } from "@/types/electron";
import GeneralPanel from "./GeneralPanel";

/** The app mounts one `TooltipProvider` at its root; see GeneralPanel.open-logs-folder.test.tsx. */
function render(ui: ReactElement, options?: Parameters<typeof renderBare>[1]) {
	return renderBare(ui, { wrapper: TooltipProvider, ...options });
}

vi.mock("@/queries/runs", () => ({
	useAllRunsQuery: () => ({ data: [] }),
	useInvalidateRuns: () => vi.fn(),
}));

vi.mock("@/services", () => ({
	apiService: { deleteRun: vi.fn() },
}));

vi.mock("./UpdatesCard", () => ({ UpdatesCard: () => null }));
vi.mock("./CookiesCard", () => ({ CookiesCard: () => null }));

const SUPPORTED_OFF: LoginItemInfo = {
	supported: true,
	reason: null,
	openAtLogin: false,
	needsApproval: false,
};

const getLoginItem = vi.fn();
const setLoginItem = vi.fn();

function installBridge(initial: LoginItemInfo) {
	// The OS: a write changes what the next read says.
	let current = initial;
	getLoginItem.mockReset().mockImplementation(async () => current);
	setLoginItem.mockReset().mockImplementation(async (on: boolean) => {
		current = { ...current, openAtLogin: on };
		return current;
	});
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		getAppPaths: vi.fn().mockResolvedValue({
			appDir: "/app",
			dataDir: "/data",
			dbPath: "/data/db",
			logsPath: "/data/logs",
		}),
		getLoginItem,
		setLoginItem,
	};
}

const card = () =>
	document.querySelector<HTMLElement>("[data-setting-anchor='start-at-login']") as HTMLElement;

beforeEach(() => installBridge(SUPPORTED_OFF));

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
	useToastStore.setState({ toasts: [] });
});

describe("GeneralPanel - Start at login", () => {
	it("renders the switch off when the OS says the item is not registered", async () => {
		render(<GeneralPanel />);

		const toggle = await screen.findByRole("switch", { name: /start vayu at login/i });
		expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(card()).toHaveTextContent("Start at login");
	});

	it("renders the switch on when the OS says it is registered", async () => {
		installBridge({ ...SUPPORTED_OFF, openAtLogin: true });
		render(<GeneralPanel />);

		const toggle = await screen.findByRole("switch", { name: /start vayu at login/i });
		expect(toggle).toHaveAttribute("aria-checked", "true");
	});

	it("writes through the bridge and re-reads what the OS now says", async () => {
		render(<GeneralPanel />);
		const toggle = await screen.findByRole("switch", { name: /start vayu at login/i });
		const readsBefore = getLoginItem.mock.calls.length;

		await act(async () => {
			fireEvent.click(toggle);
		});

		expect(setLoginItem).toHaveBeenCalledExactlyOnceWith(true);
		await waitFor(() => expect(getLoginItem.mock.calls.length).toBeGreaterThan(readsBefore));
		await waitFor(() =>
			expect(screen.getByRole("switch", { name: /start vayu at login/i })).toHaveAttribute(
				"aria-checked",
				"true"
			)
		);
	});

	it("shows what the OS says when it refused the write", async () => {
		// The OS is the authority: a write that did not take leaves the switch off.
		getLoginItem.mockResolvedValue(SUPPORTED_OFF);
		setLoginItem.mockResolvedValue(SUPPORTED_OFF);
		render(<GeneralPanel />);
		const toggle = await screen.findByRole("switch", { name: /start vayu at login/i });

		await act(async () => {
			fireEvent.click(toggle);
		});

		expect(setLoginItem).toHaveBeenCalledWith(true);
		expect(screen.getByRole("switch", { name: /start vayu at login/i })).toHaveAttribute(
			"aria-checked",
			"false"
		);
	});

	it("toasts a failed write and still re-reads", async () => {
		render(<GeneralPanel />);
		const toggle = await screen.findByRole("switch", { name: /start vayu at login/i });
		setLoginItem.mockRejectedValue(new Error("EACCES"));
		const readsBefore = getLoginItem.mock.calls.length;

		await act(async () => {
			fireEvent.click(toggle);
		});

		await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
		const [toast] = useToastStore.getState().toasts;
		expect(toast.message).toContain("EACCES");
		expect(toast.variant).toBe("error");
		expect(getLoginItem.mock.calls.length).toBeGreaterThan(readsBefore);
	});

	it("prints the reason and no switch when the build cannot register one", async () => {
		installBridge({
			supported: false,
			reason: "Start at login is available in the installed app.",
			openAtLogin: false,
			needsApproval: false,
		});
		render(<GeneralPanel />);

		expect(await screen.findByText(/available in the installed app/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("switch", { name: /start vayu at login/i })
		).not.toBeInTheDocument();
		expect(card()).not.toBeNull();
	});

	it("keeps the card, with a fallback line, when there is no electronAPI", () => {
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
		render(<GeneralPanel />);

		expect(card()).not.toBeNull();
		expect(card()).toHaveTextContent(/available in the desktop app/i);
		expect(
			screen.queryByRole("switch", { name: /start vayu at login/i })
		).not.toBeInTheDocument();
	});

	it("tells the user where to approve a held item", async () => {
		installBridge({ ...SUPPORTED_OFF, needsApproval: true });
		render(<GeneralPanel />);

		expect(
			await screen.findByText("Approve Vayu under System Settings › General › Login Items")
		).toBeInTheDocument();
	});

	it("shows no approval hint otherwise", async () => {
		render(<GeneralPanel />);
		await screen.findByRole("switch", { name: /start vayu at login/i });

		expect(screen.queryByText(/System Settings/)).not.toBeInTheDocument();
	});
});

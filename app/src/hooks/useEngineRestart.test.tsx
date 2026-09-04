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
 * A restart that failed is a terminal answer to something slow, which is the
 * shape of event the user may have walked away from (#1358).
 *
 * The success path is deliberately not asserted here: it waits out
 * `ENGINE_RESTART_WAIT_MS` and then invalidates the world, which this file
 * would have to drive with fake timers to say anything about - and what it
 * would say is covered where the window it opens is read (`health.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const showToast = vi.fn();
const { mockNotifyPost } = vi.hoisted(() => ({ mockNotifyPost: vi.fn() }));
vi.mock("@/services/notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/notify")>()),
	systemNotify: { post: mockNotifyPost, availability: vi.fn() },
}));

import { useEngineRestart } from "./useEngineRestart";
import { NOTIFY_KINDS } from "@/services/notify";
import { useEngineStore, useToastStore } from "@/stores";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return createElement(QueryClientProvider, { client }, children);
}

/** The preload bridge, with `restartEngine` answering however the case needs. */
function stubElectron(result: { success: boolean; error?: string }): void {
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		restartEngine: vi.fn().mockResolvedValue(result),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	useToastStore.setState({ showToast });
	useEngineStore.setState({ engineStartWindow: null });
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("useEngineRestart", () => {
	it("reports a refused restart to the user, in the app and out of it", async () => {
		stubElectron({ success: false, error: "port 9876 still in use" });
		const { result } = renderHook(() => useEngineRestart(), { wrapper });

		await act(async () => {
			await result.current.restart();
		});

		expect(showToast).toHaveBeenCalledWith(
			expect.objectContaining({ variant: "error", message: expect.stringContaining("9876") })
		);
		// Beside the toast, never instead of it - a user still on the Settings
		// banner sees the toast and nothing else, because main suppresses a
		// notification while the window is in front.
		expect(mockNotifyPost).toHaveBeenCalledWith({
			kind: NOTIFY_KINDS.engineRestartFailed,
			title: "The engine could not be restarted",
			body: "port 9876 still in use",
		});
	});

	it("says something even when the failure carries no reason", async () => {
		stubElectron({ success: false });
		const { result } = renderHook(() => useEngineRestart(), { wrapper });

		await act(async () => {
			await result.current.restart();
		});

		// Pins the shared `reason` fallback: the toast and the notification say
		// the same thing, rather than one of them reading "undefined".
		expect(mockNotifyPost).toHaveBeenCalledWith(
			expect.objectContaining({ body: "unknown error" })
		);
	});

	it("says nothing to the OS outside the desktop app", async () => {
		const { result } = renderHook(() => useEngineRestart(), { wrapper });

		await act(async () => {
			await result.current.restart();
		});

		// A browser dev session has no daemon to restart. The warning toast
		// explains that; an OS notification about it would be noise.
		expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: "warning" }));
		expect(mockNotifyPost).not.toHaveBeenCalled();
	});
});

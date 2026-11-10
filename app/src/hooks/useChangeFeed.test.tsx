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
 * The change feed is held only while the engine is connected (issue #3420):
 * both sides of that gate, and the hand-over across a disconnect.
 */

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEngineStore, type EngineStatus } from "@/stores";

const service = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("@/services/change-feed-service", () => ({ changeFeedService: service }));

const { useChangeFeed } = await import("./useChangeFeed");

function setStatus(engineStatus: EngineStatus) {
	act(() => useEngineStore.setState({ engineStatus }));
}

function setup() {
	const queryClient = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	const view = renderHook(() => useChangeFeed(), { wrapper });
	return { queryClient, view };
}

beforeEach(() => {
	service.start.mockClear();
	service.stop.mockClear();
});

afterEach(() => {
	useEngineStore.setState({ engineStatus: "starting" });
});

describe("useChangeFeed", () => {
	it("opens the feed on the app's client while the engine is connected", () => {
		setStatus("connected");
		const { queryClient } = setup();
		expect(service.start).toHaveBeenCalledWith(queryClient);
	});

	it.each<EngineStatus>(["starting", "unreachable"])(
		"opens nothing while the engine is %s",
		(status) => {
			setStatus(status);
			setup();
			expect(service.start).not.toHaveBeenCalled();
		}
	);

	it("closes the feed when the engine goes, and opens it again when it comes back", () => {
		setStatus("starting");
		const { queryClient } = setup();

		setStatus("connected");
		expect(service.start).toHaveBeenCalledTimes(1);

		setStatus("unreachable");
		expect(service.stop).toHaveBeenCalledTimes(1);

		setStatus("connected");
		expect(service.start).toHaveBeenCalledTimes(2);
		expect(service.start).toHaveBeenLastCalledWith(queryClient);
	});

	it("closes the feed on unmount", () => {
		setStatus("connected");
		const { view } = setup();
		view.unmount();
		expect(service.stop).toHaveBeenCalledTimes(1);
	});
});

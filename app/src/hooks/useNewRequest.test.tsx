/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useNewRequest } from "./useNewRequest";
import { DrawerItemOpenedProvider } from "@/components/layout/drawer-item-opened";
import { useSessionStore, useTabsStore, useToastStore } from "@/stores";
import { ApiError, EngineUnreachableError } from "@/services/http-client";

const mocks = vi.hoisted(() => ({
	createRequest: vi.fn(),
	createCollection: vi.fn(),
}));

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: [{ id: "c1", name: "API" }] }),
	useCreateRequestMutation: () => ({ mutateAsync: mocks.createRequest, isPending: false }),
	useCreateCollectionMutation: () => ({ mutateAsync: mocks.createCollection }),
}));

function lastToastMessage(): string | undefined {
	return useToastStore.getState().toasts.slice(-1)[0]?.message;
}

async function failWith(error: unknown): Promise<void> {
	mocks.createRequest.mockRejectedValue(error);
	vi.spyOn(console, "error").mockImplementation(() => {});
	const { result } = renderHook(() => useNewRequest());
	act(() => result.current.newRequest());
	await waitFor(() => expect(lastToastMessage()).toBeDefined());
}

describe("useNewRequest", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		mocks.createRequest = vi.fn();
		useToastStore.setState({ toasts: [] });
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		useSessionStore.setState({ lastCollectionId: null });
	});

	describe("when the create fails", () => {
		it("says what went wrong for an error that is not the engine being down", async () => {
			await failWith(new ApiError(400, "bad_request", "name is too long"));
			expect(lastToastMessage()).toBe("Couldn't create the request - name is too long");
		});

		it("keeps the bare message for a thrown value that is not an Error", async () => {
			await failWith("boom");
			expect(lastToastMessage()).toBe("Couldn't create the request");
		});

		it("points at the engine only when it did not answer", async () => {
			await failWith(new EngineUnreachableError("Failed to fetch"));
			expect(lastToastMessage()).toBe(
				"Couldn't create the request. Check that Vayu's engine is running."
			);
		});
	});

	describe("where focus goes once the request is open", () => {
		beforeEach(() => {
			mocks.createRequest.mockResolvedValue({ id: "r1" });
		});

		function activeTab() {
			const { openTabs, activeTabId } = useTabsStore.getState();
			return openTabs.find((t) => t.id === activeTabId);
		}

		it("asks for the URL field on a blank request", async () => {
			const { result } = renderHook(() => useNewRequest());
			act(() => result.current.newRequest());
			await waitFor(() =>
				expect(activeTab()).toMatchObject({ type: "request", entityId: "r1" })
			);
			expect(useTabsStore.getState().navIntent).toEqual({ kind: "focusUrl", target: "r1" });
		});

		it("asks for nothing on a request created from a preset", async () => {
			const { result } = renderHook(() => useNewRequest());
			act(() =>
				result.current.newRequest({ name: "Demo", method: "GET", url: "https://x.test" })
			);
			await waitFor(() =>
				expect(activeTab()).toMatchObject({ type: "request", entityId: "r1" })
			);
			expect(useTabsStore.getState().navIntent).toBeNull();
		});

		it("asks for the URL field when the caller names the collection", async () => {
			const { result } = renderHook(() => useNewRequest());
			act(() => result.current.newRequest(undefined, { collectionId: "c1" }));
			await waitFor(() => expect(activeTab()).toMatchObject({ entityId: "r1" }));
			expect(useTabsStore.getState().navIntent).toEqual({ kind: "focusUrl", target: "r1" });
		});
	});

	/*
	 * A request created from inside the drawer (the collection tree's own "New
	 * request") is a pick from it, like a row-menu Add request: an overlay leaves
	 * once the tab is open (#3507).
	 */
	describe("telling the drawer the new tab is open", () => {
		const onItemOpened = vi.fn();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<DrawerItemOpenedProvider value={onItemOpened}>{children}</DrawerItemOpenedProvider>
		);

		beforeEach(() => {
			onItemOpened.mockClear();
		});

		it.each([
			["blank", undefined],
			["from a preset", { name: "Demo", method: "GET", url: "https://x.test" }],
		])("does after a %s request opens", async (_label, preset) => {
			mocks.createRequest.mockResolvedValue({ id: "r1" });
			const { result } = renderHook(() => useNewRequest(), { wrapper });
			act(() => result.current.newRequest(preset));
			await waitFor(() => expect(onItemOpened).toHaveBeenCalledTimes(1));
			expect(useTabsStore.getState().openTabs.map((t) => t.entityId)).toEqual(["r1"]);
		});

		it("does not when the create fails and no tab opens", async () => {
			mocks.createRequest.mockRejectedValue(new Error("boom"));
			vi.spyOn(console, "error").mockImplementation(() => {});
			const { result } = renderHook(() => useNewRequest(), { wrapper });
			act(() => result.current.newRequest());
			await waitFor(() => expect(lastToastMessage()).toBeDefined());
			expect(onItemOpened).not.toHaveBeenCalled();
		});
	});

	describe("the create payload", () => {
		beforeEach(() => {
			mocks.createRequest.mockResolvedValue({ id: "r1" });
		});

		it("forwards the preset's fields and nothing else the caller handed over", async () => {
			const { result } = renderHook(() => useNewRequest());
			const preset = {
				name: "From a run",
				method: "POST",
				url: "https://example.test",
				description: "Saved from a run",
				headers: [{ key: "X-A", value: "1", enabled: true }],
				// Not a field of the request: whatever arrives with the preset stays behind.
				stray: "ignored",
			};
			act(() => result.current.newRequest(preset));
			await waitFor(() => expect(mocks.createRequest).toHaveBeenCalled());
			expect(mocks.createRequest.mock.calls[0][0]).toEqual({
				collectionId: "c1",
				name: "From a run",
				method: "POST",
				url: "https://example.test",
				description: "Saved from a run",
				headers: [{ key: "X-A", value: "1", enabled: true }],
			});
		});
	});
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useNewRequest } from "./useNewRequest";
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

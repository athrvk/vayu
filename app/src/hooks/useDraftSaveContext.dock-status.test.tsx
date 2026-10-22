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
 * The Dock's "Unsaved changes" line reads only `useSaveStore`'s store-wide
 * `status`, never a context's own `hasPendingChanges` (see save-store.ts) -
 * so a registered context that never touches `status` is invisible to it.
 * `AuthTab`, `InfoTab` and `ScriptTab` register through this hook and never
 * called `markPendingSave`/`completeSaveThenIdle` themselves (#1483): every
 * collection editor could sit dirty for as long as the app ran without the
 * Dock ever saying so.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SaveBlockedError } from "@/lib/elements";
import { useToastStore } from "@/stores/toast-store";
import { act, renderHook } from "@testing-library/react";
import { useSaveStore } from "@/stores/save-store";
import { ApiError } from "@/services/http-client";
import { useDraftSaveContext } from "./useDraftSaveContext";
import { useEntityDraft } from "./useEntityDraft";

beforeEach(() => {
	useSaveStore.setState({
		status: "idle",
		lastErrorMessage: null,
		contexts: new Map(),
		activeContextId: null,
	});
	useToastStore.setState({ toasts: [] });
});

interface Props {
	id: string;
	isDirty: boolean;
}

function mount(initial: Props, save: () => Promise<void> = () => Promise.resolve()) {
	return renderHook(
		(props: Props) =>
			useDraftSaveContext({
				id: props.id,
				name: "Test editor",
				isDirty: props.isDirty,
				isActive: true,
				save,
			}),
		{ initialProps: initial }
	);
}

describe("useDraftSaveContext's Dock status wiring", () => {
	it("marks the Dock pending the moment the draft goes dirty", () => {
		const { rerender } = mount({ id: "a", isDirty: false });
		expect(useSaveStore.getState().status).toBe("idle");

		rerender({ id: "a", isDirty: true });

		expect(useSaveStore.getState().status).toBe("pending");
	});

	it("reports the save as complete once the draft goes clean again", () => {
		const { rerender } = mount({ id: "a", isDirty: true });
		expect(useSaveStore.getState().status).toBe("pending");

		rerender({ id: "a", isDirty: false });

		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("does not re-fire on every render while the draft stays dirty", () => {
		const { rerender } = mount({ id: "a", isDirty: true });
		expect(useSaveStore.getState().status).toBe("pending");

		// A sibling save elsewhere in the app moved the Dock to "saved"; an
		// unrelated re-render of this still-dirty editor must not stomp it back
		// to "pending" - only the rising edge does that.
		useSaveStore.setState({ status: "saved" });
		rerender({ id: "a", isDirty: true });

		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("never mistakes a different entity's abandoned edit for a completed save", () => {
		// Mutation check: dropping the `prev.id === id` guard turns this "saved" -
		// as if switching away from a dirty draft with no save in between were
		// itself a save. Left "pending" is the safer of the two wrong answers.
		const { rerender } = mount({ id: "a", isDirty: true });
		expect(useSaveStore.getState().status).toBe("pending");

		rerender({ id: "b", isDirty: false });

		expect(useSaveStore.getState().status).toBe("pending");
	});
});

describe("a discarded draft is not a save (#1931)", () => {
	/** The way the editors wire it: the real draft hook feeding the real context hook. */
	function mountEditor(saved: string) {
		const statuses: string[] = [];
		const unsubscribe = useSaveStore.subscribe((s) => statuses.push(s.status));
		const view = renderHook(
			({ value }: { value: string }) => {
				const draft = useEntityDraft<string>({
					entityKey: "a",
					value,
					mutation: { reset: () => {} },
				});
				useDraftSaveContext({
					id: "a",
					name: "Test editor",
					isDirty: draft.isDirty,
					isActive: true,
					save: () => Promise.resolve(),
					consumeDiscard: draft.consumeDiscard,
				});
				return draft;
			},
			{ initialProps: { value: saved } }
		);
		return { ...view, statuses, unsubscribe };
	}

	it("a reset reports idle, not saved", () => {
		const { result, statuses, unsubscribe } = mountEditor("stored");
		act(() => result.current.setDraft("edited"));
		expect(useSaveStore.getState().status).toBe("pending");

		act(() => result.current.reset());

		unsubscribe();
		expect(useSaveStore.getState().status).toBe("idle");
		expect(statuses).not.toContain("saved");
	});

	it("a save that lands after a discard still reports saved", () => {
		const { result, rerender } = mountEditor("stored");
		act(() => result.current.setDraft("edited"));
		act(() => result.current.reset());
		expect(useSaveStore.getState().status).toBe("idle");

		act(() => result.current.setDraft("second edit"));
		rerender({ value: "second edit" });

		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("a reset of a clean draft leaves nothing behind to colour the next save", () => {
		const { result, rerender } = mountEditor("stored");
		act(() => result.current.reset());

		act(() => result.current.setDraft("edited"));
		rerender({ value: "edited" });

		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("leaves another editor's unsaved edit showing", () => {
		useSaveStore.getState().registerContext({
			id: "sibling",
			name: "Sibling",
			save: () => Promise.resolve(),
			hasPendingChanges: true,
		});
		const { result } = mountEditor("stored");
		act(() => result.current.setDraft("edited"));

		act(() => result.current.reset());

		expect(useSaveStore.getState().status).toBe("pending");
	});

	describe("taking the persisted side's value (adopt)", () => {
		interface Named {
			name: string;
			description: string;
		}
		const stored: Named = { name: "Acme", description: "Payouts" };

		/** `InfoTab`'s wiring: an object draft, the real context hook, `consumeDiscard` passed. */
		function mountObjectEditor() {
			const statuses: string[] = [];
			const unsubscribe = useSaveStore.subscribe((s) => statuses.push(s.status));
			const view = renderHook(
				({ value }: { value: Named }) => {
					const draft = useEntityDraft<Named>({
						entityKey: "a",
						value,
						mutation: { reset: () => {} },
					});
					useDraftSaveContext({
						id: "a",
						name: "Test editor",
						isDirty: draft.isDirty,
						isActive: true,
						save: () => Promise.resolve(),
						consumeDiscard: draft.consumeDiscard,
					});
					return draft;
				},
				{ initialProps: { value: stored } }
			);
			return { ...view, statuses, unsubscribe };
		}

		it("adopting the only edited field reports idle, not saved", () => {
			const { result, rerender, statuses, unsubscribe } = mountObjectEditor();
			act(() => result.current.setDraft((d) => ({ ...d, name: "Mine" })));
			rerender({ value: { ...stored, name: "Theirs" } });
			expect(useSaveStore.getState().status).toBe("pending");

			act(() => result.current.adopt((d) => ({ ...d, name: "Theirs" })));

			unsubscribe();
			expect(useSaveStore.getState().status).toBe("idle");
			expect(statuses).not.toContain("saved");
		});

		it("adopting one field while another is still edited leaves the later save reading as a save", () => {
			const { result, rerender } = mountObjectEditor();
			act(() => {
				result.current.setDraft({ name: "Mine", description: "My notes" });
			});
			rerender({ value: { ...stored, name: "Theirs" } });

			act(() => result.current.adopt((d) => ({ ...d, name: "Theirs" })));
			expect(useSaveStore.getState().status).toBe("pending");

			rerender({ value: { name: "Theirs", description: "My notes" } });

			expect(useSaveStore.getState().status).toBe("saved");
		});
	});

	it("reports a clean edge as a save when the editor offers no discard signal", () => {
		const { rerender } = mount({ id: "a", isDirty: true });

		rerender({ id: "a", isDirty: false });

		expect(useSaveStore.getState().status).toBe("saved");
	});
});

describe("useDraftSaveContext's save verdict", () => {
	const registeredSave = (id: string) => {
		const context = useSaveStore.getState().contexts.get(id);
		if (!context) throw new Error(`no context registered as ${id}`);
		return context.save;
	};

	it("reports a save the editor blocked as pending, without a failure", async () => {
		mount({ id: "a", isDirty: true }, () => Promise.reject(new SaveBlockedError()));

		await expect(registeredSave("a")()).resolves.toBe("pending");

		expect(useSaveStore.getState().status).toBe("pending");
		expect(useSaveStore.getState().lastErrorMessage).toBeNull();
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});

	it("reports a rejected save as failed and toasts it", async () => {
		mount({ id: "a", isDirty: true }, () => Promise.reject(new Error("boom")));

		await expect(registeredSave("a")()).resolves.toBe("failed");

		expect(useSaveStore.getState().status).toBe("error");
		expect(useSaveStore.getState().lastErrorMessage).toContain("boom");
	});

	it("reports a resolved save as saved", async () => {
		mount({ id: "a", isDirty: true });

		await expect(registeredSave("a")()).resolves.toBe("saved");
	});
});

describe("how a draft save's rejection is reported (#2423)", () => {
	async function flushRejecting(error: Error) {
		mount({ id: "a", isDirty: true }, () => Promise.reject(error));
		return act(() => useSaveStore.getState().flushAll());
	}

	it("is a disk-full failure when the engine answered 507", async () => {
		const result = await flushRejecting(
			new ApiError(507, "insufficient_storage", "The disk holding Vayu's data is full")
		);

		expect(result).toEqual({ saved: 0, failed: 1, pending: 0, reason: "disk-full" });
		expect(useSaveStore.getState().lastErrorMessage).toBe(
			"Couldn't save Test editor - The disk holding Vayu's data is full"
		);
	});

	it("is a plain failure for any other rejection", async () => {
		const result = await flushRejecting(new ApiError(500, "internal_error", "boom"));

		expect(result).toEqual({ saved: 0, failed: 1, pending: 0 });
	});
});

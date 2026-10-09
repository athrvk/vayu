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
import { renderHook } from "@testing-library/react";
import { useSaveStore } from "@/stores/save-store";
import { useDraftSaveContext } from "./useDraftSaveContext";

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

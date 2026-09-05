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
 * The three collection tabs each hand-rolled this, and the copies had drifted -
 * `InfoTab` never cleared its save mutation on a collection switch, so a
 * failure on one collection kept being reported against the next. These tests
 * pin the parts that drifted: what counts as a switch, what a switch does, and
 * that an unsaved draft survives everything except a switch or a change to the
 * persisted value.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useEntityDraft } from "./useEntityDraft";

interface Named {
	name: string;
	description: string;
}

function setup(initial: { entityKey: string; value: Named }) {
	const reset = vi.fn();
	const view = renderHook(
		(props: { entityKey: string; value: Named }) =>
			useEntityDraft<Named>({ ...props, mutation: { reset } }),
		{ initialProps: initial }
	);
	return { ...view, reset };
}

const acme: Named = { name: "Acme API", description: "" };

describe("useEntityDraft - the draft itself", () => {
	it("seeds from the persisted value and starts clean", () => {
		const { result } = setup({ entityKey: "c1", value: acme });

		expect(result.current.draft).toEqual(acme);
		expect(result.current.isDirty).toBe(false);
	});

	it("goes dirty on an edit and clean again when the edit is undone", () => {
		const { result } = setup({ entityKey: "c1", value: acme });

		act(() => result.current.setDraft((d) => ({ ...d, name: "Renamed" })));
		expect(result.current.isDirty).toBe(true);

		act(() => result.current.setDraft((d) => ({ ...d, name: "Acme API" })));
		expect(result.current.isDirty).toBe(false);
	});

	it("compares by value, so an unrelated re-render does not go dirty", () => {
		// The InfoTab case: `value` is an object literal rebuilt every render.
		// Tracking it by identity would resync (and re-render) forever.
		const { result, rerender } = setup({ entityKey: "c1", value: acme });

		act(() => result.current.setDraft({ name: "Renamed", description: "" }));
		rerender({ entityKey: "c1", value: { ...acme } });

		expect(result.current.draft.name).toBe("Renamed");
		expect(result.current.isDirty).toBe(true);
	});

	it("reset throws the draft away", () => {
		const { result } = setup({ entityKey: "c1", value: acme });

		act(() => result.current.setDraft({ name: "Renamed", description: "notes" }));
		act(() => result.current.reset());

		expect(result.current.draft).toEqual(acme);
		expect(result.current.isDirty).toBe(false);
	});

	it("resyncs when the persisted value changes under it", () => {
		// A save landing, or a background refetch. This is also what clears the
		// post-trim divergence in InfoTab: the tab persists `name.trim()`, so the
		// draft has to follow the trimmed value back or it stays dirty forever.
		const { result, rerender } = setup({ entityKey: "c1", value: { ...acme, name: "Acme  " } });

		act(() => result.current.setDraft({ name: "Acme  ", description: "" }));
		rerender({ entityKey: "c1", value: acme });

		expect(result.current.draft.name).toBe("Acme API");
		expect(result.current.isDirty).toBe(false);
	});
});

describe("useEntityDraft - switching entity", () => {
	it("reseeds the draft, discarding an unsaved edit", () => {
		const { result, rerender } = setup({ entityKey: "c1", value: acme });

		act(() => result.current.setDraft({ name: "Renamed", description: "" }));
		rerender({ entityKey: "c2", value: { name: "Other API", description: "" } });

		expect(result.current.draft.name).toBe("Other API");
		expect(result.current.isDirty).toBe(false);
	});

	it("clears the save mutation on the switch, and only on a switch", () => {
		// The bug this hook exists to make unrepresentable: a mutation holds
		// `isError` until the next mutate, and these editors are rendered without
		// a key, so a failure on one entity would otherwise be reported against
		// the next one - which the user never tried to save.
		const { rerender, reset } = setup({ entityKey: "c1", value: acme });
		expect(reset).toHaveBeenCalledTimes(1);

		// Same entity, new props: an edit or a refetch, not a switch.
		rerender({ entityKey: "c1", value: { ...acme, description: "notes" } });
		expect(reset).toHaveBeenCalledTimes(1);

		rerender({ entityKey: "c2", value: { name: "Other API", description: "" } });
		expect(reset).toHaveBeenCalledTimes(2);
	});

	it("treats a different sub-field of the same entity as a switch", () => {
		// ScriptTab passes `${collection.id}:${fieldKey}` - pre and post are two
		// different things to edit under one collection id.
		const { rerender, reset } = setup({ entityKey: "c1:preRequestScript", value: acme });
		expect(reset).toHaveBeenCalledTimes(1);

		rerender({ entityKey: "c1:postRequestScript", value: acme });
		expect(reset).toHaveBeenCalledTimes(2);
	});
});

describe("useEntityDraft - a dirty draft against a background refetch (#1437)", () => {
	it("keeps the draft and records the pending value instead of overwriting it", () => {
		// On today's unfixed master this rerender replaces the draft with the
		// agent's write, which is the exact defect #1437 reports.
		const { result, rerender } = setup({ entityKey: "c1", value: acme });

		act(() => result.current.setDraft({ name: "Renamed", description: "" }));
		rerender({ entityKey: "c1", value: { ...acme, description: "written by an agent" } });

		expect(result.current.draft).toEqual({ name: "Renamed", description: "" });
		expect(result.current.isDirty).toBe(true);
		expect(result.current.externalValue).toEqual({
			name: "Acme API",
			description: "written by an agent",
		});
		// The baseline stays what the draft actually diverged from, not the
		// pending value - callers diff against this to tell which side touched
		// which field.
		expect(result.current.baseline).toEqual(acme);
	});

	it("does not flag a conflict when the refetch only echoes the draft's own save", () => {
		const { result, rerender } = setup({ entityKey: "c1", value: acme });

		act(() => result.current.setDraft({ name: "Renamed", description: "" }));
		rerender({ entityKey: "c1", value: { name: "Renamed", description: "" } });

		expect(result.current.externalValue).toBeNull();
		expect(result.current.isDirty).toBe(false);
		expect(result.current.baseline).toEqual({ name: "Renamed", description: "" });
	});

	it("reset adopts the pending value and clears the conflict", () => {
		const { result, rerender } = setup({ entityKey: "c1", value: acme });

		act(() => result.current.setDraft({ name: "Renamed", description: "" }));
		rerender({ entityKey: "c1", value: { ...acme, description: "written by an agent" } });
		expect(result.current.externalValue).not.toBeNull();

		act(() => result.current.reset());

		expect(result.current.draft).toEqual({
			name: "Acme API",
			description: "written by an agent",
		});
		expect(result.current.isDirty).toBe(false);
		expect(result.current.externalValue).toBeNull();
		expect(result.current.baseline).toEqual({
			name: "Acme API",
			description: "written by an agent",
		});
	});
});

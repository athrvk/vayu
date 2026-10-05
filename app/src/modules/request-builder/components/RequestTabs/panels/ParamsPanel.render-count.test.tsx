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
 * Typing in one Params row re-renders that row only (issue #1716).
 *
 * `ParamsPanel`'s `onChange` used to list `request.params` in its deps, so the
 * keystroke that rewrote the params handed `KeyValueEditor` a new callback and
 * re-created every row callback under it. Same probe as the editor's own test:
 * a counting `memo` around `KeyValueRow`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { memo, createElement, useCallback, useState, type ComponentProps } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type KeyValueRowType from "@/components/shared/KeyValueEditor/KeyValueRow";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import type { KeyValueItem } from "@/types";
import ParamsPanel from "./ParamsPanel";

const renderCounts: Record<string, number> = {};

vi.mock("@/components/shared/KeyValueEditor/KeyValueRow", async (importOriginal) => {
	const mod = await importOriginal<{ default: typeof KeyValueRowType }>();
	const Counting = memo((props: ComponentProps<typeof KeyValueRowType>) => {
		renderCounts[props.item.id] = (renderCounts[props.item.id] ?? 0) + 1;
		return createElement(mod.default, props);
	});
	return { default: Counting };
});

afterEach(cleanup);

const IDS = ["r1", "r2", "r3", "r4", "r5"];
const PARAMS: KeyValueItem[] = IDS.map((id, i) => ({
	id,
	key: `k${i + 1}`,
	value: `v${i + 1}`,
	enabled: true,
}));

// Module-level: the real provider keeps these stable, and a fresh identity per
// render would bust `useVariableSupport`'s memo and mask what is under test.
const resolveString = (s: string) => s;
const getAllVariables = () => ({});
const getVariableOrigins = () => [];
const updateVariable = () => {};
const writableScopes: never[] = [];

/** A provider whose `updateField` writes back, as the real one does. */
function Harness() {
	const [request, setRequest] = useState<RequestState>(() => ({
		...createDefaultRequestState(),
		id: "req_render_count",
		url: "https://example.test/x?k1=v1&k2=v2&k3=v3&k4=v4&k5=v5",
		params: PARAMS,
	}));
	const updateField = useCallback(
		(field: keyof RequestState, value: unknown) =>
			setRequest((prev) => ({ ...prev, [field]: value })),
		[]
	);
	const value = {
		request,
		updateField,
		resolveString,
		getAllVariables,
		getVariableOrigins,
		updateVariable,
		writableScopes,
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
	return (
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<ParamsPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

describe("Params rows under a keystroke", () => {
	it("re-renders only the row being typed in, not its siblings", () => {
		render(<Harness />);
		for (const id of IDS) renderCounts[id] = 0;

		fireEvent.change(screen.getByDisplayValue("v3"), { target: { value: "v3x" } });

		expect(screen.getByDisplayValue("v3x")).toBeTruthy();
		expect(renderCounts.r3).toBeGreaterThan(0);
		for (const id of ["r1", "r2", "r4", "r5"]) expect(renderCounts[id]).toBe(0);
	});
});

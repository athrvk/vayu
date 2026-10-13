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
 * "Copy for agent" on a run sample (#2047).
 *
 * An icon button in `SampledExchange`'s actions slot, outside the toggle, so a
 * copy never expands the row. A copy that landed swaps the glyph to a check and
 * raises no toast; the line carries two ids and nothing the sample captured.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { useToastStore } from "@/stores";
import SampleRequestCard from "./SampleRequestCard";
import type { SampleResult } from "../../types";
import type { RunSample } from "@/types/domain";

const SENTINEL = "s3cr3t-sentinel";

// The captured response mounts Monaco through CodeEditor; stub it so the
// expanded case stays in jsdom.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const SAMPLE: SampleResult = {
	id: 42,
	timestamp: 1_700_000_000_000,
	statusCode: 200,
	latencyMs: 5,
	error: SENTINEL,
};

const CAPTURED: RunSample = {
	resultId: 42,
	response: { headers: { authorization: SENTINEL }, body: SENTINEL, bodyBytes: 3 },
};

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

function renderCard(props: Partial<React.ComponentProps<typeof SampleRequestCard>> = {}) {
	return render(
		<SampleRequestCard
			sample={SAMPLE}
			index={2}
			isExpanded={false}
			onToggle={vi.fn()}
			captured={CAPTURED}
			runId="run_9"
			{...props}
		/>
	);
}

const copyButton = () => screen.queryByRole("button", { name: "Copy sample 3 for agent" });

/** The glyph a button shows now; `IconSwap` keeps the other one invisible beside it. */
function liveGlyph(button: HTMLElement): string {
	return button.querySelector(".enter-fade svg")?.getAttribute("class") ?? "";
}

describe("Copy for agent on a run sample", () => {
	it("copies the formatter's line", async () => {
		renderCard();

		fireEvent.click(copyButton()!);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith("Vayu run sample (42) of run (run_9)");
	});

	it("swaps the glyph to a check and raises no toast", async () => {
		renderCard();
		const button = copyButton()!;
		expect(liveGlyph(button)).toContain("lucide-copy");

		fireEvent.click(button);

		await waitFor(() => expect(liveGlyph(button)).toContain("lucide-check"));
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("keeps everything the sample captured off the clipboard", async () => {
		renderCard({ isExpanded: true });

		fireEvent.click(copyButton()!);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).not.toContain(SENTINEL);
	});

	it("does not toggle the row", async () => {
		const onToggle = vi.fn();
		renderCard({ onToggle });

		fireEvent.click(copyButton()!);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("is absent without a run id", () => {
		renderCard({ runId: undefined });

		expect(copyButton()).toBeNull();
	});

	it("is absent for a sample with no result id", () => {
		renderCard({ sample: { ...SAMPLE, id: undefined } });

		expect(copyButton()).toBeNull();
	});
});

/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThroughputTwinCard } from "./ThroughputTwinCard";
import type { DispatchStatus } from "../../utils/dispatchLag";

const draw = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

describe("ThroughputTwinCard chip", () => {
	// The card draws the verdict it is handed: 560 req/s apart reads the same
	// numbers whichever way the producer judged them.
	it.each<[DispatchStatus, string, string, string]>([
		["kept-pace", "server kept pace with dispatch", "bg-success/10", "text-success-text"],
		["lagging", "server is lagging dispatch", "bg-destructive/10", "text-destructive-text"],
		["settling", "still measuring the gap", "bg-muted", "text-muted-foreground"],
	])("draws %s as '%s' in its own tokens", (status, sentence, fill, text) => {
		draw(<ThroughputTwinCard sendRate={4500} throughput={3940} status={status} />);

		expect(screen.getByText(sentence)).toBeTruthy();
		const chip = screen.getByText("Δ 560 req/s");
		expect(chip.className).toContain(fill);
		expect(chip.className).toContain(text);
		expect(chip.className).toContain("rounded-sm");
	});

	it("does not re-judge the numbers it prints", () => {
		// A 1 req/s gap would have read lagging under the card's old rule.
		draw(<ThroughputTwinCard sendRate={500} throughput={450} status="kept-pace" />);

		expect(screen.getByText("server kept pace with dispatch")).toBeTruthy();
		expect(screen.queryByText("server is lagging dispatch")).toBeNull();
	});

	it("draws no chip without a verdict, however far apart the rates are", () => {
		draw(<ThroughputTwinCard sendRate={4500} throughput={3940} />);

		expect(screen.getByText("4,500")).toBeTruthy();
		expect(screen.queryByText(/Δ/)).toBeNull();
		expect(screen.queryByText(/server/)).toBeNull();
	});

	it("draws no chip for a verdict with no rates to show", () => {
		draw(<ThroughputTwinCard status="lagging" />);

		expect(screen.queryByText(/Δ/)).toBeNull();
	});
});

describe("ThroughputTwinCard received caption", () => {
	// The live card is fed run-cumulative metrics and passes no window.
	it.each([
		[undefined, "received"],
		["sending" as const, "received while sending"],
		["wholeRun" as const, "received, whole run"],
	])("captions a %s window as '%s'", (receivedWindow, caption) => {
		draw(
			<ThroughputTwinCard sendRate={200} throughput={190} receivedWindow={receivedWindow} />
		);

		expect(screen.getByText(caption)).toBeTruthy();
	});

	it("prints the delta of the received figure it is handed", () => {
		draw(
			<ThroughputTwinCard
				sendRate={200}
				throughput={198}
				receivedWindow="sending"
				status="kept-pace"
			/>
		);

		expect(screen.getByText("Δ 2 req/s")).toBeTruthy();
	});
});

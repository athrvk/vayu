/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ReactNode } from "react";
import { concurrencyUnit } from "@/constants/load-test-modes";
import type { LiveCapacityState } from "@/types/domain";
import type { CapacityResult } from "@/components/shared/capacityStop";
import { formatNumber } from "@/lib/format-number";
import { formatDuration, pluralize } from "../../utils/format";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell, HeroValue } from "./HeroCardShell";

function Line({ children }: { children: ReactNode }) {
	return <p className="text-label text-muted-foreground font-mono mt-0.5">{children}</p>;
}

function Figure({ children }: { children: ReactNode }) {
	return <span className="text-foreground font-semibold">{children}</span>;
}

/**
 * capacity hero card #1 - where the search is, then what it found. A search
 * climbs toward the ceiling the user set, so the old "N of 100 active"
 * utilisation card read progress as load actually held (#2929). Live it names
 * the level being measured from the `capacity` frame block (#2928); once the
 * report is here it reads `capacity` from it and states the ceiling only as
 * a bound ("of up to 100").
 */
export function CapacitySearchCard({
	live,
	capacity,
	ceiling,
}: {
	live?: LiveCapacityState;
	capacity?: CapacityResult;
	ceiling?: number;
}) {
	if (capacity) return <FoundCard capacity={capacity} ceiling={ceiling} />;

	const level = live?.level ?? 0;
	return (
		<HeroCardShell label="Searching" tip={TOOLTIPS.capacitySearch}>
			{level > 0 ? (
				<HeroValue value={formatNumber(level)} unit={concurrencyUnit(level)} />
			) : (
				<HeroValue value="-" unit="starting" />
			)}
			{live && level > 0 && (
				<Line>
					<Figure>{formatDuration(live.levelElapsedMs)}</Figure> into this level
					{" · "}
					<Figure>{formatNumber(live.levelsJudged)}</Figure>{" "}
					{pluralize(live.levelsJudged, "level")} judged
				</Line>
			)}
		</HeroCardShell>
	);
}

function FoundCard({ capacity, ceiling }: { capacity: CapacityResult; ceiling?: number }) {
	const held = capacity.maxHealthyConcurrency;
	const knee = capacity.kneeConcurrency;
	return (
		<HeroCardShell label="Search result" tip={TOOLTIPS.capacitySearch}>
			{held === undefined ? (
				<HeroValue value="none" unit="held its budgets" />
			) : (
				<HeroValue value={formatNumber(held)} unit={`${concurrencyUnit(held)} held`} />
			)}
			<Line>
				{knee !== undefined && (
					<>
						gave out at <Figure>{formatNumber(knee)}</Figure>
						{ceiling !== undefined && " of"}
					</>
				)}
				{knee === undefined && ceiling !== undefined && "searched"}
				{ceiling !== undefined && (
					<>
						{" up to "}
						<Figure>{formatNumber(ceiling)}</Figure> {concurrencyUnit(ceiling)}
					</>
				)}
			</Line>
		</HeroCardShell>
	);
}

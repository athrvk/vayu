/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatLatencyParts } from "@/lib/format-number";

/**
 * One `key value unit` figure of the HDR plot's footer; a dash when the report
 * lacks it. The unit comes with the value (`formatLatencyParts`), so a tail past
 * a second reads `1.23s`-style rather than `1,234ms`.
 */
export function LatencyStat({ k, v }: { k: string; v: number | undefined }) {
	const { value, unit } = formatLatencyParts(v);
	return (
		<span>
			<span className="text-muted-foreground">{k}</span>{" "}
			<span className="text-foreground font-semibold">{v === undefined ? "-" : value}</span>
			<span className="text-muted-foreground">{v === undefined ? "" : unit}</span>
		</span>
	);
}

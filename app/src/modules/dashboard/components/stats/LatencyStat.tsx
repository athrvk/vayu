/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatMs } from "@/lib/format-number";

/** One `key value ms` figure of the HDR plot's footer; a dash when the report lacks it. */
export function LatencyStat({ k, v }: { k: string; v: number | undefined }) {
	return (
		<span>
			<span className="text-muted-foreground">{k}</span>{" "}
			<span className="text-foreground font-semibold">
				{v === undefined ? "-" : formatMs(v)}
			</span>
			<span className="text-muted-foreground">{v === undefined ? "" : "ms"}</span>
		</span>
	);
}

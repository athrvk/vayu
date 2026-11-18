/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** Each Logs column's width, shared by the rows (`LogRow`) and the header over them. */
export const LOG_COLUMNS = {
	time: "w-24 shrink-0",
	source: "w-16 shrink-0",
	component: "w-20 shrink-0",
	message: "min-w-0 flex-[3]",
	fields: "min-w-0 flex-[2]",
} as const;

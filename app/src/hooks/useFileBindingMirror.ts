/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { installFileBindingMirror } from "@/queries/file-bindings";

/**
 * Keep `useSpecFileStore` and `useDataFileStore` a mirror of the collections
 * list's `specFile` / `dataFile` (#2765). Mounted once at the root, before
 * `useDataFileLocationMirror`, which publishes the data-file half onward to
 * the main process.
 */
export function useFileBindingMirror(): void {
	const queryClient = useQueryClient();
	useEffect(() => installFileBindingMirror(queryClient), [queryClient]);
}

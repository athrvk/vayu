/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { logError } from "@/errors/error-logger";
import { useCollectionsQuery } from "@/queries/collections";
import { writeFileBinding } from "@/queries/file-bindings";
import { importLegacyFileBindings } from "@/queries/legacy-file-bindings";

/**
 * Move the spec-file and data-file bindings an older Vayu kept in
 * `localStorage` onto the engine's rows, once, after the first collections
 * list arrives (#2765) - the list is what says which collections still exist
 * and which already hold a binding. Mounted at the root; a launch whose writes
 * fail leaves the keys for the next one.
 */
export function useLegacyFileBindingImport(): void {
	const queryClient = useQueryClient();
	const { data: collections } = useCollectionsQuery();
	const started = useRef(false);

	useEffect(() => {
		if (!collections || started.current) return;
		started.current = true;
		void importLegacyFileBindings(collections, {
			// Reached per call, so a storage that refuses access throws inside
			// the import, which logs it and keeps the keys.
			storage: {
				getItem: (key) => window.localStorage.getItem(key),
				removeItem: (key) => window.localStorage.removeItem(key),
			},
			write: (update) => writeFileBinding(queryClient, update),
			log: (error, action) => logError(error, "medium", { component: "renderer", action }),
		});
	}, [collections, queryClient]);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Active-environment rehydrate validation.
 *
 * `activeEnvironmentId` is persisted, so it outlives the environment it names:
 * a delete performed by another window, a reset database, or a stored id from
 * before the delete-time cleanup existed all leave a dangling id in
 * localStorage. The switcher hides that (a defensive `find()` renders "No
 * Environment"), but every send still forwards the id to `/compose`, so the UI
 * says none while the wire says a deleted one.
 *
 * This clears it once - and only once - the engine has actually answered.
 */

import { useEffect } from "react";
import { useEnvironmentsQuery } from "@/queries";
import { useSessionStore } from "@/stores/session-store";

export function useActiveEnvironmentGuard(): void {
	const { data: environments, isSuccess } = useEnvironmentsQuery();
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const setActiveEnvironmentId = useSessionStore((s) => s.setActiveEnvironmentId);

	useEffect(() => {
		/*
		 * `isSuccess` is the load-bearing condition, not `environments.length`:
		 * an unreachable engine or a failed fetch leaves the list empty too, and
		 * clearing on that would throw away a perfectly good selection every time
		 * the app started before the engine did.
		 */
		if (!isSuccess || !activeEnvironmentId) return;
		if (!environments.some((e) => e.id === activeEnvironmentId)) {
			setActiveEnvironmentId(null);
		}
	}, [isSuccess, environments, activeEnvironmentId, setActiveEnvironmentId]);
}

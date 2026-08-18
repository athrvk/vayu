/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Active-environment restore.
 *
 * The engine owns which environment is active (`environments.is_active`, at
 * most one row, enforced in the DB layer). The session store holds the same id
 * so the switcher, the resolver and every composed payload can read it
 * synchronously - it is a cache of the engine's answer, not a second source of
 * truth, and this hook is what makes that true at startup.
 *
 * Two directions, and which one applies is decided by the engine, not by
 * whichever value looks newer:
 *
 * - The engine has an active environment: adopt it. It outranks the persisted
 *   copy because it is the value another window, a reinstall-surviving
 *   database, or a CLI write already agreed on. This is what restores the
 *   selection after the app is closed and reopened.
 * - The engine has none but a persisted id names an environment that exists:
 *   push it to the engine, once. That is the upgrade path - every user whose
 *   choice predates the engine storing it would otherwise silently lose it on
 *   first launch - and it is also self-healing after a write that failed.
 * - The engine had one this session and now has none: adopt the clear. Someone
 *   deactivated it deliberately - the MCP `activate_environment` tool with
 *   "none", or a write through another client - and pushing the stale copy back
 *   would undo their write with the app's own memory of it. The upgrade push
 *   above is for an engine that has *never* held a selection, which is why the
 *   two are told apart by what this session has already seen the engine answer
 *   rather than by the value alone.
 *
 * Deliberately not merged with `useActiveEnvironmentGuard` (clearing a
 * persisted id whose environment is gone): that guard answers "does this id
 * still exist", this hook answers "which id does the engine hold". They
 * compose - a dangling id is cleared there, and if the engine holds a real one
 * it is adopted here.
 */

import { useEffect, useRef } from "react";
import { useIsMutating } from "@tanstack/react-query";
import {
	useEnvironmentsQuery,
	useSetActiveEnvironmentMutation,
	setActiveEnvironmentMutationKey,
} from "@/queries/environments";
import { useSessionStore } from "@/stores/session-store";

export function useActiveEnvironmentRestore(): void {
	const { data: environments, isSuccess } = useEnvironmentsQuery();
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const setActiveEnvironmentId = useSessionStore((s) => s.setActiveEnvironmentId);
	const setActiveEnvironment = useSetActiveEnvironmentMutation();
	const isSwitching = useIsMutating({ mutationKey: setActiveEnvironmentMutationKey }) > 0;
	/*
	 * The adoption push is once per session, and the ref is what makes it once:
	 * without it an engine that keeps rejecting the write would be re-asked on
	 * every refetch of the list, turning a failed write into a request loop.
	 */
	const hasPushedPersistedSelection = useRef(false);
	/*
	 * Whether the engine has answered with an active environment at any point
	 * this session. It is what separates "the engine has never been told" - the
	 * upgrade path, which pushes - from "the engine was told and has since been
	 * cleared", which adopts.
	 */
	const hasSeenEngineSelection = useRef(false);

	useEffect(() => {
		/*
		 * `isSuccess` gates both directions. An unreachable engine returns no
		 * environments, which is indistinguishable from "no environments exist"
		 * on the data alone - adopting from that would clear a good selection
		 * every time the app won the startup race against the engine.
		 *
		 * Standing back while a switch is in flight keeps this from fighting the
		 * user: the optimistic store value is already the answer, and a list
		 * refetch that lands mid-flight still carries the old active row.
		 */
		if (!isSuccess || isSwitching) return;

		const engineActiveId = environments.find((e) => e.isActive)?.id ?? null;

		if (engineActiveId) {
			hasSeenEngineSelection.current = true;
			if (engineActiveId !== activeEnvironmentId) {
				setActiveEnvironmentId(engineActiveId);
			}
			return;
		}

		/*
		 * The engine held a selection this session and holds none now, so the
		 * clear is the newer fact and the store follows it. Without this the
		 * push below would fire on the very next refetch and put the deactivated
		 * id straight back - an MCP or CLI "no environment" write undone by the
		 * window that was only meant to be watching.
		 */
		if (hasSeenEngineSelection.current) {
			if (activeEnvironmentId) setActiveEnvironmentId(null);
			return;
		}

		if (
			!hasPushedPersistedSelection.current &&
			activeEnvironmentId &&
			environments.some((e) => e.id === activeEnvironmentId)
		) {
			hasPushedPersistedSelection.current = true;
			setActiveEnvironment.mutate({ id: activeEnvironmentId, previousId: null });
		}
		// `setActiveEnvironment` is a stable-enough mutation object, but including
		// it would re-run this on every render of the mutation state; the ref and
		// the id comparison are what actually gate the work.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isSuccess, isSwitching, environments, activeEnvironmentId, setActiveEnvironmentId]);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Restores the active environment at startup. The engine owns it (`environments.is_active`, at most
 * one row, enforced in the DB layer); the session store holds the same id so the switcher, the
 * resolver and every composed payload read it synchronously. That copy is a cache of the engine's
 * answer, not a second source of truth, and this hook makes it true at startup.
 *
 * The engine decides which direction applies, not whichever value looks newer:
 *
 * - The engine has an active environment: adopt it. It outranks the persisted copy because another
 *   window, a reinstall-surviving database or a CLI write already agreed on it. This restores the
 *   selection after the app is closed and reopened.
 * - The engine has none and a persisted id names an environment that exists: push it to the engine,
 *   once. The upgrade path (a choice from before the engine stored it would otherwise be lost on
 *   first launch), and self-healing after a failed write.
 * - The engine had one this session and now has none: adopt the clear. Someone deactivated it on
 *   purpose (the MCP `activate_environment` tool with "none", or a write through another client),
 *   and pushing the stale copy back would undo their write. The upgrade push is for an engine that
 *   has *never* held a selection, so the two are told apart by what this session has seen the
 *   engine answer, not by the value alone.
 *
 * Not merged with `useActiveEnvironmentGuard` (clearing a persisted id whose environment is gone):
 * the guard answers "does this id still exist", this hook "which id does the engine hold". They
 * compose: a dangling id is cleared there, and a real one the engine holds is adopted here.
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
	 * Whether the engine has answered with an active environment at any point this session: what
	 * separates "never told" (the upgrade path, which pushes) from "told and since cleared" (which
	 * adopts).
	 */
	const hasSeenEngineSelection = useRef(false);

	useEffect(() => {
		/*
		 * `isSuccess` gates both directions: an unreachable engine returns no environments, which
		 * the data alone cannot tell from "none exist", and adopting from that would clear a good
		 * selection whenever the app wins the startup race against the engine.
		 *
		 * Standing back while a switch is in flight keeps this from fighting the user: the
		 * optimistic store value is already the answer, and a list refetch landing mid-flight still
		 * carries the old active row.
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
		 * The engine held a selection this session and holds none now, so the clear is the newer
		 * fact and the store follows it. Otherwise the push below fires on the next refetch and
		 * puts the deactivated id straight back: an MCP or CLI "no environment" write undone by a
		 * window that was only watching.
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
			setActiveEnvironment.mutate({ id: activeEnvironmentId });
		}
		// `setActiveEnvironment` is a stable-enough mutation object, but including
		// it would re-run this on every render of the mutation state; the ref and
		// the id comparison are what actually gate the work.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isSuccess, isSwitching, environments, activeEnvironmentId, setActiveEnvironmentId]);
}

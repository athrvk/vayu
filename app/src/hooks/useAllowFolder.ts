/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Adding an allowed folder, the one way every surface does it. Three surfaces offer it (Settings >
 * Files, the binary body editor's "Allow folder…", the import preview's per-folder action), and
 * each would otherwise copy the same outcomes: the folder is allowed now; it already was (the
 * engine's 409, the result the user wanted, so not an error); or the engine refused it (400, a
 * folder it will not allow, its message naming the path and the reason).
 *
 * The folder is always one the user chose in the system picker, which the main process opens and
 * then allows itself: an allowed folder widens what every request may read from disk, so the
 * renderer cannot name one (#2356), nor say where the picker opens or what its title says (#2378);
 * main opens it where the last folder dialog ended. Outside Electron there is no picker and nothing
 * that may make the write, so `chooseAndAllow` is absent.
 */

import { useCallback } from "react";
import { ENGINE_NO_ANSWER } from "@/lib/engine-error-text";
import { useAllowChosenFolderMutation } from "@/queries";
import { useToastStore } from "@/stores";
import type { AllowFolderReply } from "@/types/electron";

export interface AllowFolder {
	/**
	 * Open the system folder picker, then allow what was chosen. Resolves true
	 * when the chosen folder is allowed afterwards, false on cancel or refusal.
	 * Absent outside Electron.
	 */
	chooseAndAllow?: () => Promise<boolean>;
	isPending: boolean;
}

type ShowToast = (message: string, kind: "success" | "info" | "error") => void;

/** Tell the user what became of the folder they chose. True when it is allowed now. */
function announce(reply: AllowFolderReply, showToast: ShowToast): boolean {
	switch (reply.outcome) {
		case "cancelled":
			return false;
		case "done":
			showToast(`Files under ${reply.value.path} can be sent now.`, "success");
			return true;
		case "refused":
			if (reply.status === 409) {
				showToast(`${reply.path} is already an allowed folder.`, "info");
				return true;
			}
			showToast(`Couldn't allow ${reply.path}: ${reply.message}`, "error");
			return false;
		case "unreachable":
			showToast(`Couldn't allow ${reply.path}: ${ENGINE_NO_ANSWER}`, "error");
			return false;
	}
}

export function useAllowFolder(): AllowFolder {
	const allowChosen = useAllowChosenFolderMutation();
	const showToast = useToastStore((s) => s.showToast);
	const bridged = typeof window !== "undefined" && Boolean(window.electronAPI?.allowFolder);

	const chooseAndAllow = useCallback(async (): Promise<boolean> => {
		let reply: AllowFolderReply;
		try {
			reply = await allowChosen.mutateAsync();
		} catch {
			// The bridge itself refused or broke: nothing reached the engine.
			showToast("Couldn't open the folder picker. Restart Vayu.", "error");
			return false;
		}
		return announce(reply, showToast);
	}, [allowChosen, showToast]);

	return {
		...(bridged ? { chooseAndAllow } : {}),
		isPending: allowChosen.isPending,
	};
}

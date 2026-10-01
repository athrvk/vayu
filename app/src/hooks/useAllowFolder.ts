/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Adding an allowed folder, the one way every surface does it.
 *
 * Three surfaces offer it - Settings > Files, the binary body editor's
 * "Allow folder...", and the import preview's per-folder action - and each
 * would otherwise grow its own copy of the same three outcomes: the folder is
 * allowed now; it already was (the engine's 409, which is the result the user
 * wanted, so it is not an error); or the engine refused it (400: not an
 * existing directory on this machine, which is what an imported path from
 * another computer usually is). The engine's own message is shown for the
 * refusal, since it names the path and the reason.
 */

import { useCallback } from "react";
import { useCreateFileRootMutation } from "@/queries";
import { ApiError } from "@/services/http-client";
import { useToastStore } from "@/stores";

export interface AllowFolder {
	/** Allow `path` as typed. Resolves true when the folder is allowed afterwards. */
	allow: (path: string) => Promise<boolean>;
	/**
	 * Open the system folder picker (starting at `defaultPath`), then allow
	 * what was chosen. Resolves false on cancel. Absent outside Electron.
	 */
	chooseAndAllow?: (defaultPath?: string) => Promise<boolean>;
	isPending: boolean;
}

export function useAllowFolder(): AllowFolder {
	const create = useCreateFileRootMutation();
	const showToast = useToastStore((s) => s.showToast);

	const allow = useCallback(
		async (path: string): Promise<boolean> => {
			try {
				const row = await create.mutateAsync(path);
				showToast(`Files under ${row.path} can be sent now.`, "success");
				return true;
			} catch (error) {
				if (error instanceof ApiError && error.statusCode === 409) {
					showToast(`${path} is already an allowed folder.`, "info");
					return true;
				}
				const detail =
					error instanceof ApiError && error.message
						? error.message
						: "The engine didn't answer.";
				showToast(`Couldn't allow ${path}: ${detail}`, "error");
				return false;
			}
		},
		[create, showToast]
	);

	const selectDirectory =
		typeof window !== "undefined" ? window.electronAPI?.selectDirectory : undefined;
	const chooseAndAllow = useCallback(
		async (defaultPath?: string): Promise<boolean> => {
			if (!selectDirectory) return false;
			const chosen = await selectDirectory({
				title: "Allow a folder",
				...(defaultPath ? { defaultPath } : {}),
			});
			if (!chosen) return false;
			return await allow(chosen);
		},
		[allow, selectDirectory]
	);

	return {
		allow,
		...(selectDirectory ? { chooseAndAllow } : {}),
		isPending: create.isPending,
	};
}

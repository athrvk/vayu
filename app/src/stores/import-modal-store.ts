/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { create } from "zustand";

interface ImportModalState {
	isOpen: boolean;
	/**
	 * A file the OS handed Vayu to import, waiting for the dialog to read it
	 * (issue #1364) - a document dropped on the Dock/taskbar icon, or a file
	 * argument on the command line. Null once nothing is waiting.
	 */
	pendingPath: string | null;
	open: () => void;
	/** Open the dialog already carrying a file to import. */
	openWithFile: (path: string) => void;
	close: () => void;
	/**
	 * Read and clear `pendingPath` in one step, so a re-render of the dialog
	 * cannot see the same path twice and import it twice.
	 */
	takePendingPath: () => string | null;
}

export const useImportModalStore = create<ImportModalState>((set, get) => ({
	isOpen: false,
	pendingPath: null,
	open: () => set({ isOpen: true }),
	openWithFile: (path) => set({ isOpen: true, pendingPath: path }),
	close: () => set({ isOpen: false, pendingPath: null }),
	takePendingPath: () => {
		const path = get().pendingPath;
		set({ pendingPath: null });
		return path;
	},
}));

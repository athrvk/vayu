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
	/**
	 * Files dropped on the window outside the dialog (issue #2252), waiting for
	 * the dialog to import them. Empty once nothing is waiting.
	 */
	pendingFiles: File[];
	open: () => void;
	/** Open the dialog already carrying a file to import. */
	openWithFile: (path: string) => void;
	/** Open the dialog already carrying dropped files. An empty list changes nothing. */
	openWithFiles: (files: File[]) => void;
	close: () => void;
	/**
	 * Read and clear `pendingPath` in one step, so a re-render of the dialog
	 * cannot see the same path twice and import it twice.
	 */
	takePendingPath: () => string | null;
	/** `takePendingPath` for `pendingFiles`: read and clear in one step. */
	takePendingFiles: () => File[];
}

export const useImportModalStore = create<ImportModalState>((set, get) => ({
	isOpen: false,
	pendingPath: null,
	pendingFiles: [],
	open: () => set({ isOpen: true }),
	openWithFile: (path) => set({ isOpen: true, pendingPath: path }),
	openWithFiles: (files) => {
		if (files.length === 0) return;
		set({ isOpen: true, pendingFiles: files });
	},
	close: () => set({ isOpen: false, pendingPath: null, pendingFiles: [] }),
	takePendingPath: () => {
		const path = get().pendingPath;
		set({ pendingPath: null });
		return path;
	},
	takePendingFiles: () => {
		const files = get().pendingFiles;
		set({ pendingFiles: [] });
		return files;
	},
}));

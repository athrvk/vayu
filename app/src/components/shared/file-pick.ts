/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turning a file the user chose into a path the engine can open - the part a
 * form-data file part (`FilePartCell`) and a binary body (`BinaryBodyPanel`)
 * share, so a fix to one reaches the other.
 *
 * **A path, never bytes.** The engine opens the file at send time, so the
 * renderer takes the path from the preload (`getFilePath`, Electron's
 * `webUtils`) and reads nothing. Outside Electron there is no path to take and
 * `src` comes back `""`; the caller keeps the reference unresolved then,
 * because a filename alone is not something the engine can open.
 *
 * **The picker's input is hidden, and cleared after every change**, since
 * the same file twice in a row is not a change event and the user could not
 * re-pick the file they just replaced.
 */

import { useCallback, useRef } from "react";

export interface PickedFile {
	/** Absolute path, or "" outside Electron - the caller keeps the reference unresolved then. */
	src: string;
	fileName: string;
	contentType: string;
}

/** A `File` from a picker or a drop, as the reference the engine takes. */
export function pickedFileOf(file: File): PickedFile {
	return {
		src: window.electronAPI?.getFilePath(file) ?? "",
		fileName: file.name,
		contentType: file.type,
	};
}

/**
 * The hidden `<input type="file">` and the call that opens it. Spread
 * `inputProps` on the input; call `open` from the visible control.
 */
export function useFilePick(onPick: (file: PickedFile) => void) {
	const inputRef = useRef<HTMLInputElement>(null);

	const onChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			event.target.value = "";
			if (!file) return;
			onPick(pickedFileOf(file));
		},
		[onPick]
	);

	const open = useCallback(() => inputRef.current?.click(), []);

	return {
		open,
		inputProps: {
			ref: inputRef,
			type: "file" as const,
			className: "hidden",
			onChange,
			// The visible control is the button that calls `open`; this input
			// is never a tab stop or announced on its own.
			"aria-hidden": true as const,
			tabIndex: -1,
		},
	};
}

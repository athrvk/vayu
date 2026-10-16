/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A file dropped anywhere on the window opens the Import dialog with it
 * (issue #2252), the way Postman and Insomnia do.
 *
 * Both listeners are bubble-phase on `window`, which is what makes the
 * `defaultPrevented` check mean something: React delegates to the root
 * container, so the dialog's dropzone and `BinaryBodyPanel` have already run
 * and called `preventDefault` by the time the event gets here. A capture
 * listener would see every drop first and steal theirs.
 *
 * Mounted once, in `App`.
 */

import { useEffect } from "react";
import { useImportModalStore } from "@/stores";

function carriesFiles(event: DragEvent): boolean {
	return event.dataTransfer?.types.includes("Files") ?? false;
}

export function useWindowFileDrop(): void {
	useEffect(() => {
		// A drop only fires on a target whose dragover was cancelled; without
		// this the renderer would navigate to the file instead.
		const onDragOver = (event: DragEvent) => {
			if (carriesFiles(event)) event.preventDefault();
		};
		const onDrop = (event: DragEvent) => {
			if (event.defaultPrevented || !carriesFiles(event)) return;
			event.preventDefault();
			useImportModalStore
				.getState()
				.openWithFiles(Array.from(event.dataTransfer?.files ?? []));
		};
		window.addEventListener("dragover", onDragOver);
		window.addEventListener("drop", onDrop);
		return () => {
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("drop", onDrop);
		};
	}, []);
}

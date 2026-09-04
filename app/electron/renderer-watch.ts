/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a renderer left behind, cleaned up when the renderer is gone.
 *
 * Two main-process features hold state on a renderer's behalf and cannot be
 * told by that renderer when it dies: the wake lock's tokens (#1357) and the
 * taskbar's progress bar (#1362). Both need the same two lifecycle events, and
 * both need them exactly once per renderer, so this is the one copy of that -
 * a second hand-rolled one would be the copy that misses the next fix.
 *
 * `destroyed` is the window closing or the process going; `did-start-loading`
 * is a reload, where the new page cannot hand back what the old page took.
 */

/** The slice of `webContents` the two events need. */
export interface RendererLike {
	id: number;
	once(event: "destroyed", listener: () => void): unknown;
	on(event: "did-start-loading", listener: () => void): unknown;
}

/** An IPC event as far as this is concerned: the renderer that sent it. */
export interface IpcEventLike {
	sender: RendererLike;
}

/**
 * Build a `watch(sender)` that calls `onGone(rendererId)` when that renderer is
 * destroyed or starts loading again. Subscribing twice for one renderer is a
 * no-op, so a caller may watch on every message it handles.
 */
export function createRendererWatch(
	onGone: (rendererId: number) => void
): (sender: RendererLike) => void {
	const watched = new Set<number>();

	return function watch(sender: RendererLike): void {
		if (watched.has(sender.id)) return;
		watched.add(sender.id);
		const gone = () => onGone(sender.id);
		sender.once("destroyed", () => {
			watched.delete(sender.id);
			gone();
		});
		sender.on("did-start-loading", gone);
	};
}

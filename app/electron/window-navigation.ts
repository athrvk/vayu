/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main window's refusal to go anywhere but the app.
 *
 * `contextIsolation: true` and `nodeIntegration: false` decide what a renderer
 * may reach; neither decides *which document* the renderer is. The preload runs
 * on whatever the window has navigated to, so a main window that follows a link
 * to a third-party origin hands `window.electronAPI` - the engine, the
 * filesystem readers, the OAuth surface - to that origin. Until this existed the
 * only thing standing in front of that was an application-level convention:
 * `MarkdownView` renders links as buttons, so no `href` reaches the DOM. One
 * component, one override, and nothing underneath it. Descriptions arrive from
 * imported Postman, Insomnia and OpenAPI documents, so the content reaching that
 * convention is third-party.
 *
 * This is the layer underneath: whatever any surface renders, the window itself
 * refuses to navigate off the app, and denies `window.open` outright.
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do.
 */

/** What a `will-navigate` listener is handed, without depending on Electron's types. */
export interface NavigationAttempt {
	preventDefault(): void;
}

/** The slice of `WebContents` this needs, so a test can pass a fake. */
export interface NavigableContents {
	on(event: "will-navigate", listener: (event: NavigationAttempt, url: string) => void): unknown;
	setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): unknown;
}

function parseUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

/**
 * Whether a navigation target is the app itself rather than somewhere else.
 *
 * The two builds are the app in two different forms, and the identity that
 * distinguishes them is not spelled the same way:
 *
 * - **Production is the app scheme, `vayu-app://app/` (#2380), where `origin`
 *   cannot be the test.** Node gives a URL on a scheme it does not know the
 *   opaque origin `"null"`, the same one every `file:` URL has, so comparing
 *   origins would accept `file:///etc/passwd` as the app's own. The scheme and
 *   the host are compared instead, which is what Chromium's origin for the
 *   registered scheme is made of.
 * - **Development is the Vite dev server, where the origin is exactly the
 *   test.** A full reload (an HMR update the client cannot apply in place) is
 *   page-initiated, so it arrives here as a real navigation, and it may land on
 *   any path under that origin. A rule tighter than the origin would refuse it
 *   and break the dev loop for everyone, which is a worse outcome than the hole
 *   this closes.
 *
 * Anything unparseable is refused rather than guessed at.
 */
export function isAppOwnUrl(target: string, appUrl: string): boolean {
	const to = parseUrl(target);
	const app = parseUrl(appUrl);
	if (!to || !app) return false;
	if (app.protocol === "http:" || app.protocol === "https:") {
		return to.origin === app.origin;
	}
	// A host is required: without one (a `file:` URL) every local document would
	// share the app's identity.
	return app.host !== "" && to.protocol === app.protocol && to.host === app.host;
}

/**
 * Refuse every navigation that is not the app itself, and deny `window.open`.
 *
 * `appUrl` is the URL the window is loading - the dev server in development, the
 * app scheme's entry (`APP_ENTRY_URL`) in production. It is passed in rather than
 * derived here so the caller cannot drift from what it actually loads.
 *
 * The deny is unconditional because nothing in this app calls `window.open`: an
 * outbound link goes through the scheme-validated `openExternalUrl` IPC to the
 * user's browser, which is where a third-party page belongs. A child window
 * would carry the preload the same way a navigation does.
 */
export function installWindowNavigationGuard(contents: NavigableContents, appUrl: string): void {
	contents.on("will-navigate", (event, url) => {
		if (isAppOwnUrl(url, appUrl)) return;
		event.preventDefault();
	});
	contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

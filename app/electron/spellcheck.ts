/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * No spellcheck dictionary is ever fetched (#1355).
 *
 * `webPreferences.spellcheck: false` only switches the checker off for one
 * renderer. The Hunspell download belongs to the *session's* spellcheck
 * service, which loads its language list when the session is created - so the
 * default session fetched `en-US` from Google's CDN at launch, and the OAuth
 * window's partition did it again, with every window already opted out.
 * `setSpellCheckerEnabled(false)` does not stop it; an empty language list
 * does. Electron documents the call as a no-op on macOS, where the OS checker
 * is used and nothing is downloaded, so it is made unconditionally.
 */

import type { App, Session } from "electron";

/** Give a session no spellcheck languages, so it has no dictionary to download. */
export function dropSpellCheckerLanguages(target: Pick<Session, "setSpellCheckerLanguages">): void {
	target.setSpellCheckerLanguages([]);
}

/**
 * Apply `dropSpellCheckerLanguages` to every session the app ever creates.
 *
 * Must run before the first session exists - at module scope, ahead of
 * `app.whenReady` - because the download starts at creation: a listener
 * registered later misses the default session, and `session-created` also
 * covers each `fromPartition` session the OAuth window opens.
 */
export function suppressDictionaryDownloads(target: Pick<App, "on">): void {
	target.on("session-created", dropSpellCheckerLanguages);
}

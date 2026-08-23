/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * KeyboardShortcutsPanel
 *
 * The read-only list of every chord the app listens for (#951). Until it
 * existed, ⌘W, ⌘B, ⌘I and ⌘1-9 appeared nowhere on screen: the Dock advertised
 * the drawer switchers, the URL bar advertised Send and Load Test, and the rest
 * lived in a handler and a doc.
 *
 * **It holds no list.** Rows come from `SHORTCUT_GROUPS` in
 * `constants/shortcuts.ts`, each row's name from that chord's own `label`, and
 * its key-caps from `chordKeys` - the same function the Dock's tooltips and the
 * response pane's empty state render through. A table of names and keys typed
 * out here is the exact defect #938 removed from the Shell, and it would be
 * wrong the first time a chord changed. `KeyboardShortcutsPanel.test.tsx`
 * counts the rendered rows against the registry, so a chord cannot be added
 * without appearing here.
 *
 * Read-only on purpose: rebinding is a store, a persistence format, a conflict
 * check against the native menu and a matcher that reads user data. #951 scopes
 * this to the list.
 */

import { Keyboard } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Eyebrow,
	Kbd,
} from "@/components/ui";
import { chordKeys } from "@/lib/platform";
import { SHORTCUT_GROUPS } from "@/constants/shortcuts";
import { appSetting } from "../app-settings";

// The heading comes from the catalogue so search cannot offer a name this panel
// does not print - see `app-settings.ts`.
const SHORTCUTS = appSetting("keyboard-shortcuts");

export default function KeyboardShortcutsPanel() {
	return (
		<div data-setting-anchor={SHORTCUTS.anchor}>
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Keyboard className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">{SHORTCUTS.label}</CardTitle>
					</div>
					<CardDescription>
						Every shortcut the app listens for, drawn for this platform. They are not
						rebindable yet.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					{SHORTCUT_GROUPS.map((group) => (
						<div key={group.id}>
							<Eyebrow className="mb-2">{group.title}</Eyebrow>
							{/* A description list, because that is what a shortcut row is:
							    the action is the term and the chord defines it. */}
							<dl className="space-y-1">
								{group.chords.map((chord) => (
									<div
										key={`${group.id}:${chord.label}`}
										data-shortcut-row={chord.label}
										className="flex items-center justify-between gap-4 h-8"
									>
										<dt className="text-sm text-foreground">{chord.label}</dt>
										<dd className="flex items-center gap-1">
											{chordKeys(chord).map((cap) => (
												<Kbd key={cap} size="sm">
													{cap}
												</Kbd>
											))}
										</dd>
									</div>
								))}
							</dl>
						</div>
					))}
				</CardContent>
			</Card>
		</div>
	);
}

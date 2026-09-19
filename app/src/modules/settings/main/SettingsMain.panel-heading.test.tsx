/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A settings panel says its name once (issue #1688).
 *
 * `ClientSettingsPanel`'s band prints the panel's `label`, `description` and
 * `saveNote` from `app-panels.ts`. Three panels then repeated the name in a card
 * a few pixels below it, with copy that had drifted away from the band's:
 * Keyboard shortcuts said "Every chord the app listens for" in the band and
 * "Every shortcut the app listens for … They are not rebindable yet" in the
 * card, next to a save note that already said shortcuts are fixed. Editor and
 * Notifications repeated their own titles the same way.
 *
 * Two halves, because they fail separately. The rendered half proves the band is
 * the one place the name appears for a panel that actually mounts; the source
 * half covers all eight without mounting eight panels that each fetch, read
 * `window.electronAPI` or load Monaco - and it is the half that catches the next
 * panel to grow a duplicate header.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ClientSettingsPanel from "./panels/ClientSettingsPanel";
import KeyboardShortcutsPanel from "./panels/KeyboardShortcutsPanel";
import { APP_SETTINGS_PANELS, DEFAULT_SAVE_NOTE } from "./app-panels";
import { APP_SETTINGS } from "./app-settings";

const here = dirname(fileURLToPath(import.meta.url));

/** The file each app panel is declared in, keyed by its category id. */
const PANEL_FILES: Record<string, string> = {
	general: "panels/GeneralPanel.tsx",
	appearance: "panels/AppearancePanel.tsx",
	editor: "panels/EditorPanel.tsx",
	dashboard: "panels/DashboardPanel.tsx",
	"load-testing": "panels/LoadTestingPanel.tsx",
	notifications: "panels/NotificationsPanel.tsx",
	shortcuts: "panels/KeyboardShortcutsPanel.tsx",
	mcp: "panels/McpSettingsPanel.tsx",
};

/**
 * What a `<CardTitle>` in this file will print.
 *
 * Most are literal text; the rest are `{FOO.label}`, where `FOO` is an
 * `appSetting("anchor")` const at the top of the file - so the catalogue is
 * asked, rather than the string being guessed.
 */
function cardTitles(source: string): string[] {
	const anchorOf = new Map(
		[...source.matchAll(/const (\w+) = appSetting\("([^"]+)"\)/g)].map((m) => [m[1], m[2]])
	);
	const titles: string[] = [];
	for (const m of source.matchAll(/<CardTitle[^>]*>([\s\S]*?)<\/CardTitle>/g)) {
		const body = m[1].trim();
		const ref = /^\{(\w+)\.label\}$/.exec(body);
		if (ref) {
			const anchor = anchorOf.get(ref[1]);
			const setting = APP_SETTINGS.find((s) => s.anchor === anchor);
			if (setting) titles.push(setting.label);
			continue;
		}
		if (!body.includes("{")) titles.push(body.replace(/\s+/g, " "));
	}
	return titles;
}

describe("a settings panel's heading is in the band, once", () => {
	afterEach(cleanup);

	it("renders the panel's name exactly once", () => {
		const panel = APP_SETTINGS_PANELS.find((p) => p.id === "shortcuts")!;
		render(
			<ClientSettingsPanel
				title={panel.label}
				description={panel.description}
				saveNote={panel.saveNote ?? DEFAULT_SAVE_NOTE}
			>
				<KeyboardShortcutsPanel />
			</ClientSettingsPanel>
		);
		// The band's heading, and nothing else saying the same thing.
		expect(screen.getAllByText(panel.label)).toHaveLength(1);
		expect(screen.getByRole("heading", { level: 1, name: panel.label })).toBeInTheDocument();
		// The band's copy is on screen, so this is not passing because the band
		// itself stopped rendering.
		expect(screen.getByText(panel.description)).toBeInTheDocument();
		expect(screen.getByText(panel.saveNote!)).toBeInTheDocument();
		// And the panel's content is there under it.
		expect(screen.getAllByRole("definition").length).toBeGreaterThan(5);
	});

	it("no panel's card repeats the name its band already prints", () => {
		expect(APP_SETTINGS_PANELS.length).toBe(Object.keys(PANEL_FILES).length);
		for (const panel of APP_SETTINGS_PANELS) {
			const source = readFileSync(join(here, PANEL_FILES[panel.id]), "utf8");
			expect(source.length, `${panel.id} source`).toBeGreaterThan(500);
			expect(
				cardTitles(source),
				`${panel.id}: a card repeats the panel heading "${panel.label}" that the band already shows`
			).not.toContain(panel.label);
		}
	});

	it("reads real card titles, so the check above is not scanning nothing", () => {
		// Appearance's cards are genuinely sub-topics (Theme mode, Color scheme,
		// Interface) and must keep their titles - which is also proof the
		// extractor works on both shapes, a literal and an `appSetting` label.
		const source = readFileSync(join(here, PANEL_FILES.appearance), "utf8");
		const titles = cardTitles(source);
		expect(titles.length).toBeGreaterThanOrEqual(3);
		expect(titles).toContain("Interface");
	});
});

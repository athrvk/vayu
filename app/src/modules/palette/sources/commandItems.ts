/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The command registry, as palette results.
 *
 * The "do Y" half of the palette. A plain function rather than a hook like its
 * siblings, because it owns no data: it maps `lib/commands` onto `PaletteItem`,
 * which is the whole point - the palette is a way of reaching a command, not a
 * second place actions are defined.
 *
 * Unavailable commands never reach the list. A row that cannot do anything is
 * worse than a missing one: it looks like the app is broken rather than like the
 * action wants a collection open.
 */

import { availableCommands, commandTitle, type CommandContext } from "@/lib/commands";
import type { PaletteItem } from "../types";

export function commandItems(ctx: CommandContext): PaletteItem[] {
	return availableCommands(ctx).map((command) => ({
		id: `command:${command.id}`,
		kind: command.group === "settings" ? ("settings" as const) : ("command" as const),
		title: commandTitle(command, ctx),
		...(command.subtitle ? { subtitle: command.subtitle } : {}),
		keywords: [...command.keywords],
		icon: command.icon,
		...(command.shortcut ? { shortcut: command.shortcut } : {}),
		perform: () => command.perform(ctx),
	}));
}

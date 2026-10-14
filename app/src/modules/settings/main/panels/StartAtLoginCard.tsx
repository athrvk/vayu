/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * StartAtLoginCard
 *
 * The switch for opening Vayu when the user signs in to their computer
 * (issue #2098).
 *
 * **The value lives in the OS, not in this app.** A login item can be removed
 * from Task Manager, System Settings or a desktop environment's startup list
 * without Vayu being asked, so a copy kept in `client-settings-store` would
 * drift from the truth. The card reads it through the preload bridge on mount
 * and again after every write, and nothing here is persisted.
 *
 * The card always renders, with its anchor: Settings search scrolls to it, and
 * it has to be findable outside Electron and in an unpackaged run, where there
 * is nothing to switch. Whether the switch can work is the main process's
 * answer (`supported`); this component never looks at the platform.
 */

import { useEffect, useState } from "react";
import { LogIn } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { useToastStore } from "@/stores";
import type { LoginItemInfo } from "@/types/electron";
import { appSetting } from "../app-settings";
import { ToggleRow } from "./SettingControls";

// Headings come from the catalogue so search cannot offer a name this panel
// does not print - see `app-settings.ts`.
const START_AT_LOGIN = appSetting("start-at-login");

export function StartAtLoginCard() {
	const showToast = useToastStore((s) => s.showToast);
	const [state, setState] = useState<LoginItemInfo | null>(null);
	const [writing, setWriting] = useState(false);
	const hasBridge = window.electronAPI !== undefined;

	useEffect(() => {
		let live = true;
		window.electronAPI
			?.getLoginItem()
			.then((next) => {
				if (live) setState(next);
			})
			.catch(() => {
				// Nothing to show beyond the card's own copy.
			});
		return () => {
			live = false;
		};
	}, []);

	const toggle = async (on: boolean) => {
		setWriting(true);
		try {
			await window.electronAPI?.setLoginItem(on);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			showToast(`Couldn't change start at login - ${reason}`, "error");
		}
		// Re-read after the write whatever it did: the OS may have refused it, or
		// held it for approval, and what it says is what the switch must show.
		try {
			const next = await window.electronAPI?.getLoginItem();
			if (next) setState(next);
		} catch {
			// The switch keeps its last known answer.
		}
		setWriting(false);
	};

	return (
		<Card data-setting-anchor={START_AT_LOGIN.anchor}>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<LogIn className="w-5 h-5 text-muted-foreground" />
					<CardTitle>{START_AT_LOGIN.label}</CardTitle>
				</div>
				<CardDescription>Open Vayu when you sign in to this computer.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-2">
				{!hasBridge && (
					<p className="text-sm text-muted-foreground">
						Start at login is available in the desktop app.
					</p>
				)}
				{state && !state.supported && (
					<p className="text-sm text-muted-foreground">{state.reason}</p>
				)}
				{state?.supported && (
					<ToggleRow
						label="Start Vayu at login"
						description="The window opens as it does for any launch"
						checked={state.openAtLogin}
						disabled={writing}
						onChange={(on) => void toggle(on)}
					/>
				)}
				{state?.needsApproval && (
					<p className="text-xs text-muted-foreground">
						Approve Vayu under System Settings &gt; General &gt; Login Items
					</p>
				)}
			</CardContent>
		</Card>
	);
}

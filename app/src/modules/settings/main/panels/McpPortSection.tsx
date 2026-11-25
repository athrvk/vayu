/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The MCP port field of Settings › MCP, with what a change means (#3580).
 *
 * The configured port is the main process's: it validates and stores it (`validateMcpPort`) and
 * reports it, and whether it is in force yet, in `mcp:status`. This renders those answers and sends
 * the user's number, with no second copy of the verdict. The range and the reserved engine ports
 * (`mcp-port-copies.ts`) are help text and the input's native bounds only: a number outside them is
 * still sent, and the refusal that comes back is what the field shows.
 *
 * The engine learns the port only when spawned, so a saved change takes effect after an engine
 * restart. `status.restartRequired` is derived in main and survives a reload; the engine store's
 * pending-restart flag does not and would put a second, label-less banner on the engine settings,
 * so it is not set from here.
 */

import { useEffect, useRef } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button, LabelSwap } from "@/components/ui";
import { Callout } from "@/components/shared";
import type { McpStatus } from "@/types";
import { useEngineRestart } from "@/hooks/useEngineRestart";
import { DEFAULT_MCP_PORT, ENGINE_PORTS_HELP, MCP_PORT_MAX, MCP_PORT_MIN } from "./mcp-port-copies";
import { NumberSettingRow } from "./SettingControls";

const RECONNECT_NOTE =
	"Changing the port changes the endpoint URL, so every agent registered with the old URL has to be connected again.";

/** `host:port` of an endpoint URL, for naming the port the server holds right now. */
function hostPort(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * Names the port the server holds only while it holds one: off, or failed to
 * bind (another program on the port), it is on none, and the URL in the status
 * is only the port it would take.
 */
function restartNoticeText(status: McpStatus): string {
	if (!status.running) return "The new port takes effect when Vayu's engine restarts.";
	return `The MCP server stays on ${hostPort(status.url)} until Vayu's engine restarts, then it moves to port ${status.port}.`;
}

interface RestartNoticeProps {
	status: McpStatus;
	/** Called once an engine restart this notice offered has finished, either way. */
	onRestartSettled: () => void;
}

function RestartNotice({ status, onRestartSettled }: RestartNoticeProps) {
	const { restart, isRestarting } = useEngineRestart();

	// The restart is the store's, shared with the Dock and the Settings banner,
	// so it can end without this button's click having been the cause. Whoever
	// started it, the endpoint above has to be read again to show the new URL.
	const wasRestarting = useRef(false);
	useEffect(() => {
		if (isRestarting) {
			wasRestarting.current = true;
			return;
		}
		if (!wasRestarting.current) return;
		wasRestarting.current = false;
		onRestartSettled();
	}, [isRestarting, onRestartSettled]);

	return (
		<Callout
			className="enter-fade"
			severity="warning"
			title="Restart needed"
			action={
				<Button
					variant="outline"
					size="sm"
					disabled={isRestarting}
					onClick={() => void restart()}
					className="h-control-sm px-2 text-xs shrink-0"
				>
					{isRestarting ? (
						<Loader2 className="size-icon-sm animate-spin" />
					) : (
						<RefreshCw className="size-icon-sm" />
					)}
					<LabelSwap
						label={isRestarting ? "Restarting…" : "Restart engine"}
						states={["Restart engine", "Restarting…"]}
					/>
				</Button>
			}
		>
			{restartNoticeText(status)}
		</Callout>
	);
}

interface McpPortSectionProps {
	/** Null until `mcp:status` has been read; the field is disabled then. */
	status: McpStatus | null;
	/** The refusal for the last number sent, or undefined. */
	error: string | undefined;
	onCommit: (raw: string) => void;
	/** Every keystroke, so the owner can drop a refusal that no longer describes the field. */
	onDraftChange: () => void;
	onRestartSettled: () => void;
	disabled: boolean;
}

export function McpPortSection({
	status,
	error,
	onCommit,
	onDraftChange,
	onRestartSettled,
	disabled,
}: McpPortSectionProps) {
	return (
		<div className="space-y-3">
			<NumberSettingRow
				label="Port"
				description={`${ENGINE_PORTS_HELP} ${RECONNECT_NOTE}`}
				value={status ? String(status.port) : ""}
				commit="blur"
				onCommit={onCommit}
				onDraftChange={onDraftChange}
				min={String(MCP_PORT_MIN)}
				max={String(MCP_PORT_MAX)}
				error={error}
				defaultValue={String(DEFAULT_MCP_PORT)}
				onResetToDefault={() => onCommit(String(DEFAULT_MCP_PORT))}
				disabled={disabled || !status}
			/>

			{status?.storedPortError && (
				<Callout className="enter-fade" severity="warning" title="Saved port not used">
					{status.storedPortError}
				</Callout>
			)}

			{status?.restartRequired && (
				<RestartNotice status={status} onRestartSettled={onRestartSettled} />
			)}
		</div>
	);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * McpSettingsPanel
 *
 * Client-side panel for the MCP server that exposes Vayu to AI agents (Claude
 * Code, Cursor, Codex). Shows the connection status + one-command onboarding,
 * and edits the safety guardrails (allowlist / caps / writes). Config is
 * persisted by the Electron main process (not the engine config store), so this
 * panel talks to `window.electronAPI` directly. Like the other app panels it
 * auto-persists (no Save bar): discrete edits (allowlist, toggle) commit
 * immediately; cap inputs commit on blur. The main process sanitizes every
 * change before applying it.
 *
 * Because each edit commits a whole field computed from what is on screen
 * (adding a host commits the displayed allowlist plus the new one), the panel
 * never substitutes defaults for config it could not read: an IPC failure
 * surfaces as a toast and a Retry, with the editors disabled, rather than an
 * empty allowlist the next click would persist over the real one.
 *
 * See docs/engine/mcp.md and SECURITY.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Plug,
	ShieldCheck,
	Globe,
	Gauge,
	Wrench,
	Plus,
	X,
	Check,
	Copy,
	Zap,
	Loader2,
	CircleCheck,
	CircleSlash,
} from "lucide-react";
import {
	Button,
	Input,
	Label,
	Switch,
	Badge,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Skeleton,
} from "@/components/ui";
import type {
	McpConnectClient,
	McpSafetyConfig,
	McpStatus,
	McpToolCategory,
	McpToolInfo,
} from "@/types";
import { useToastStore } from "@/stores";
import { cn } from "@/lib/utils";
import { Callout } from "@/components/shared";
import { LOAD_TEST_CEILING_BOUNDS } from "@/constants/load-test";
import { NumberSettingRow, ToggleRow } from "./SettingControls";

/**
 * Shown until `mcp:status` reports the live URL - deliberately not a URL.
 *
 * The endpoint has one source of truth in the main process (`MCP_ENDPOINT_URL`,
 * built from `MCP_HOST`/`MCP_PORT`/`MCP_PATH`), which this file cannot import:
 * renderer and main share no module graph. A hardcoded copy here is a copy that
 * drifts, and a plausible-looking URL is worse than no URL - it would be copied
 * into an agent's config and silently fail to connect.
 */
const ENDPOINT_UNKNOWN = "(unavailable - MCP status not loaded)";

interface ConnectSnippet {
	label: string;
	code: string;
	/** When set, the client has a CLI we can shell out to for one-click connect. */
	client?: McpConnectClient;
}

/** Config snippets an agent uses to connect to the running Vayu MCP endpoint. */
function connectSnippets(url: string): ConnectSnippet[] {
	return [
		{
			label: "Claude Code",
			code: `claude mcp add --transport http vayu ${url}`,
			client: "claude",
		},
		{
			label: "VS Code (.vscode/mcp.json)",
			code: `{\n  "servers": {\n    "vayu": { "type": "http", "url": "${url}" }\n  }\n}`,
			client: "vscode",
		},
		{
			label: "Cursor (.cursor/mcp.json)",
			code: `{\n  "mcpServers": {\n    "vayu": { "type": "http", "url": "${url}" }\n  }\n}`,
		},
		{
			label: "Codex (~/.codex/config.toml)",
			code: `[mcp_servers.vayu]\nurl = "${url}"`,
		},
	];
}

const CLIENT_LABEL: Record<McpConnectClient, string> = {
	claude: "Claude Code",
	vscode: "VS Code",
};
const CLIENT_CLI: Record<McpConnectClient, string> = {
	claude: "claude",
	vscode: "code",
};

/**
 * Display copy for the categories this panel knows about, in display order.
 *
 * Decoration only - the rendered list is derived from the tools the main process
 * actually reports (see `groupToolsByCategory`). This panel is the only place
 * `disabledTools` is editable, so a tool whose category is missing here would
 * serve over MCP with no way to switch it off.
 */
const TOOL_CATEGORIES: { id: McpToolCategory; label: string; description: string }[] = [
	{ id: "read", label: "Read", description: "Inspect collections, runs, config, and metrics." },
	{
		id: "execute",
		label: "Execute",
		description: "Send real requests to a target (single request or a collection smoke test).",
	},
	{
		id: "write",
		label: "Write",
		description: "Create or change saved requests, environments, and engine config.",
	},
	{
		id: "load",
		label: "Load testing",
		description: "Start and stop load runs.",
	},
];

/** One rendered group of tools: the category's copy plus its members. */
interface ToolGroup {
	id: string;
	label: string;
	description: string;
	tools: McpToolInfo[];
}

/**
 * Group the reported tools for display, ordered by `TOOL_CATEGORIES` and with
 * any category that table does not describe appended under its own id. The
 * category is a plain string across the IPC boundary, so an id added on the
 * main-process side reaches here before the copy above catches up; rendering it
 * unlabelled beats dropping the tools it holds.
 */
function groupToolsByCategory(tools: McpToolInfo[]): ToolGroup[] {
	const byCategory = new Map<string, McpToolInfo[]>();
	for (const tool of tools) {
		const existing = byCategory.get(tool.category);
		if (existing) existing.push(tool);
		else byCategory.set(tool.category, [tool]);
	}

	const groups: ToolGroup[] = [];
	for (const cat of TOOL_CATEGORIES) {
		const catTools = byCategory.get(cat.id);
		if (!catTools) continue;
		groups.push({ ...cat, tools: catTools });
		byCategory.delete(cat.id);
	}
	for (const [id, catTools] of byCategory) {
		groups.push({
			id,
			label: id,
			description: "Tools in a group this version of Settings does not describe yet.",
			tools: catTools,
		});
	}
	return groups;
}

/** A small copy-to-clipboard button that flips to a check for a moment. */
function CopyButton({
	text,
	className,
	disabled,
}: {
	text: string;
	className?: string;
	disabled?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const onCopy = useCallback(() => {
		void navigator.clipboard?.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, [text]);
	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={onCopy}
			disabled={disabled}
			className={cn("h-7 px-2 text-xs shrink-0", className)}
		>
			{copied ? (
				<>
					<Check className="w-3.5 h-3.5 mr-1 text-success-text" />
					Copied
				</>
			) : (
				<>
					<Copy className="w-3.5 h-3.5 mr-1" />
					Copy
				</>
			)}
		</Button>
	);
}

interface CapField {
	key: "maxRps" | "maxConcurrency" | "maxDurationSeconds" | "maxIterations";
	label: string;
	/** Rendered as the input's suffix - units live there once, not in the label. */
	unit?: string;
	description: string;
	/**
	 * The highest value this cap may be set to. The main process holds the cap
	 * here on save (`sanitizeSafetyInput`), so the input advertises the same
	 * number rather than letting a user type one that silently comes back lower.
	 */
	ceiling: number;
}

/**
 * Each cap names the run fields it actually bounds, because a cap that reads as
 * covering every run does not: a rate cap cannot touch a run that carries no
 * rate. The mode names are the ones the load dialog shows (`LOAD_TEST_MODES`).
 */
const CAP_FIELDS: CapField[] = [
	{
		key: "maxRps",
		label: "Max RPS",
		unit: "req/s",
		description:
			"Ceiling on the request rate an agent may ask for. Only a Constant RPS run carries a rate - the closed-loop modes are held by Max concurrency and Max iterations instead.",
		ceiling: LOAD_TEST_CEILING_BOUNDS.rps.MAX,
	},
	{
		key: "maxConcurrency",
		label: "Max concurrency",
		description:
			"Ceiling on the connections a closed-loop run may hold: what Constant Concurrency holds, what a Ramp-Up starts from, and the top a Capacity Discovery search climbs to. A Constant RPS run is paced by its rate instead, so this cap does not bound its in-flight requests.",
		ceiling: LOAD_TEST_CEILING_BOUNDS.concurrency.MAX,
	},
	{
		key: "maxDurationSeconds",
		label: "Max duration",
		unit: "sec",
		description:
			"Ceiling on how long a load run may last. An iterations run stops on a count and never reads a duration, so Max iterations is what bounds that one.",
		ceiling: LOAD_TEST_CEILING_BOUNDS.durationSeconds.MAX,
	},
	{
		key: "maxIterations",
		label: "Max iterations",
		description:
			"Ceiling on requests for an iterations run, which stops on a count rather than a duration.",
		ceiling: LOAD_TEST_CEILING_BOUNDS.iterations.MAX,
	},
];

export default function McpSettingsPanel() {
	const hasElectron = typeof window !== "undefined" && !!window.electronAPI;

	const showToast = useToastStore((s) => s.showToast);

	const [status, setStatus] = useState<McpStatus | null>(null);
	const [config, setConfig] = useState<McpSafetyConfig | null>(null);
	const [tools, setTools] = useState<McpToolInfo[]>([]);
	const [newHost, setNewHost] = useState("");
	// Nothing to wait for outside Electron, where there is no IPC to call.
	const [isLoading, setIsLoading] = useState(hasElectron);
	const [connecting, setConnecting] = useState<McpConnectClient | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	// Guards the state writes below, since Retry can re-run `load` at any time
	// and the fetch it awaits may land after the panel is gone.
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// Load status + current safety config. Also the Retry handler, so a failed
	// load is recoverable without reopening Settings. Sets no state before its
	// first await - the mount effect below calls it, and a synchronous setState
	// there is a cascading render (react-hooks/set-state-in-effect).
	const load = useCallback(async () => {
		if (!window.electronAPI) return;
		try {
			const [s, c, t] = await Promise.all([
				window.electronAPI.getMcpStatus(),
				window.electronAPI.getMcpSafety(),
				window.electronAPI.getMcpTools(),
			]);
			if (!mounted.current) return;
			setStatus(s);
			setConfig(c);
			setTools(t);
			setLoadFailed(false);
		} catch (err) {
			if (!mounted.current) return;
			/*
			 * `config` deliberately stays null rather than falling back to the
			 * defaults: every edit here commits a whole field computed from what
			 * is displayed, so a stand-in empty allowlist is one click away from
			 * being persisted over the real one.
			 */
			setLoadFailed(true);
			showToast(
				err instanceof Error
					? `Couldn't load MCP settings: ${err.message}`
					: "Couldn't load MCP settings.",
				"error"
			);
		} finally {
			if (mounted.current) setIsLoading(false);
		}
	}, [showToast]);

	/*
	 * `load` writes no state before its first await, so this cannot cascade a
	 * render. The rule flags it because the callback is declared outside the
	 * effect - which is the point: Retry re-runs the same load.
	 */
	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- see above
		void load();
	}, [load]);

	// Re-check status when the user returns to the window - the server may have
	// died or been toggled elsewhere while the panel sat open.
	useEffect(() => {
		if (!window.electronAPI) return;
		const onFocus = () => {
			window.electronAPI
				?.getMcpStatus()
				.then(setStatus)
				.catch(() => {});
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);

	// Until the status arrives there is no endpoint to copy - the placeholder is
	// displayed, and every Copy is disabled so it cannot be pasted anywhere.
	const endpoint = status?.url ?? ENDPOINT_UNKNOWN;
	const hasEndpoint = status?.url !== undefined;
	const running = status?.running ?? false;
	const enabled = status?.enabled ?? false;

	// Apply a change: main sanitizes + persists and returns the resolved config,
	// which we adopt as the new source of truth.
	const persist = useCallback(
		async (partial: Partial<McpSafetyConfig>) => {
			if (!window.electronAPI) return;
			try {
				const resolved = await window.electronAPI.updateMcpSafety(partial);
				setConfig(resolved);
			} catch (err) {
				showToast(
					err instanceof Error
						? `Couldn't save MCP settings: ${err.message}`
						: "Couldn't save MCP settings.",
					"error"
				);
				/*
				 * Main applies the change to the live server before writing it to
				 * disk, so a failed write leaves live and persisted diverged. Re-read
				 * rather than keep rendering the value we tried to set.
				 */
				const current = await window.electronAPI.getMcpSafety().catch(() => null);
				if (current && mounted.current) setConfig(current);
			}
		},
		[showToast]
	);

	// Turn the MCP server on/off; main persists the preference and starts/stops
	// the server, returning the new status.
	const toggleEnabled = useCallback(
		async (next: boolean) => {
			if (!window.electronAPI) return;
			try {
				const s = await window.electronAPI.setMcpEnabled(next);
				setStatus(s);
			} catch (err) {
				showToast(
					err instanceof Error
						? `Couldn't ${next ? "start" : "stop"} the MCP server: ${err.message}`
						: `Couldn't ${next ? "start" : "stop"} the MCP server.`,
					"error"
				);
				// The preference may have been saved before the start/stop threw -
				// show what the main process ended up with, not the switch position.
				const current = await window.electronAPI.getMcpStatus().catch(() => null);
				if (current && mounted.current) setStatus(current);
			}
		},
		[showToast]
	);

	// One-click connect: shell out to the client's own CLI. Falls back to the
	// copy snippet (already shown) when the CLI isn't installed.
	const handleConnect = useCallback(
		async (client: McpConnectClient) => {
			if (!window.electronAPI) return;
			setConnecting(client);
			try {
				const res = await window.electronAPI.connectMcpClient(client);
				if (res.ok) {
					showToast(`Added Vayu to ${CLIENT_LABEL[client]}.`, "success");
				} else if (res.reason === "cli-not-found") {
					showToast(
						`The ${CLIENT_CLI[client]} CLI wasn't found - copy the snippet below to add Vayu manually.`,
						"error"
					);
				} else {
					showToast(res.message || `Couldn't connect ${CLIENT_LABEL[client]}.`, "error");
				}
			} catch (err) {
				// Without this the rejected invoke only stopped the spinner, so a
				// connect that never reached the CLI looked like nothing happened.
				showToast(
					err instanceof Error
						? `Couldn't connect ${CLIENT_LABEL[client]}: ${err.message}`
						: `Couldn't connect ${CLIENT_LABEL[client]}.`,
					"error"
				);
			} finally {
				setConnecting(null);
			}
		},
		[showToast]
	);

	const addHost = useCallback(() => {
		const host = newHost.trim().toLowerCase();
		if (!host || !config) return;
		setNewHost("");
		if (config.allowlist.includes(host)) return;
		void persist({ allowlist: [...config.allowlist, host] });
	}, [newHost, config, persist]);

	const removeHost = useCallback(
		(host: string) => {
			if (!config) return;
			void persist({ allowlist: config.allowlist.filter((h) => h !== host) });
		},
		[config, persist]
	);

	/*
	 * The draft lives in the row primitive now, so this only decides whether the
	 * committed number is worth an IPC round trip: zero and negatives are held
	 * back rather than sent for the main process to clamp, and an unchanged
	 * value is not re-persisted.
	 */
	const commitCap = useCallback(
		(key: CapField["key"], raw: string) => {
			if (!config) return;
			const n = parseInt(raw, 10);
			if (Number.isNaN(n) || n <= 0 || n === config[key]) return;
			void persist({ [key]: n });
		},
		[config, persist]
	);

	const toolGroups = useMemo(() => groupToolsByCategory(tools), [tools]);

	// Enable/disable a set of tools by name (persists the resulting disabled list).
	const setToolsEnabled = useCallback(
		(names: string[], enabled: boolean) => {
			if (!config) return;
			const disabled = new Set(config.disabledTools);
			for (const name of names) {
				if (enabled) disabled.delete(name);
				else disabled.add(name);
			}
			void persist({ disabledTools: [...disabled] });
		},
		[config, persist]
	);

	return (
		<>
			{!hasElectron && (
				<Callout severity="warning" title="Desktop only">
					MCP settings are only available in the desktop app. Run Vayu via Electron to
					configure the MCP server.
				</Callout>
			)}

			{/* A failed load leaves nothing to edit: the controls below stay disabled
			    rather than offering defaults that would overwrite the real config. */}
			{loadFailed && (
				<Callout
					severity="blocking"
					title="Couldn't load MCP settings"
					action={
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								setIsLoading(true);
								void load();
							}}
							disabled={isLoading}
							className="h-7 px-2 text-xs shrink-0"
						>
							Retry
						</Button>
					}
				>
					your saved allowlist, caps and tool switches are unchanged - editing is disabled
					until they can be read.
				</Callout>
			)}

			{/* Connection status + onboarding */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Plug className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Connection</CardTitle>
						{isLoading ? (
							<Skeleton className="h-5 w-16 ml-1" />
						) : !status ? (
							// No status read at all - "Disabled" here would be a guess.
							<Badge variant="chip" className="ml-1 bg-muted text-muted-foreground">
								<CircleSlash className="w-3 h-3 mr-1" />
								Unknown
							</Badge>
						) : !enabled ? (
							<Badge variant="chip" className="ml-1 bg-muted text-muted-foreground">
								<CircleSlash className="w-3 h-3 mr-1" />
								Disabled
							</Badge>
						) : running ? (
							<Badge
								variant="chip"
								className="ml-1 border border-success/20 bg-success/10 text-success-text"
							>
								<CircleCheck className="w-3 h-3 mr-1" />
								Running
							</Badge>
						) : (
							<Badge
								variant="chip"
								className="ml-1 border border-warning/30 bg-warning/10 text-warning-text"
							>
								<CircleSlash className="w-3 h-3 mr-1" />
								Stopped
							</Badge>
						)}
					</div>
					<CardDescription>
						Any agent connects to the already-running app with one command - no extra
						process to manage.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{/* Server on/off */}
					<ToggleRow
						className="rounded-md border border-border bg-muted/30 px-3 py-2.5"
						label="Enable MCP server"
						description="On by default: while Vayu is running, a connected agent can reach the endpoint below. When off, the endpoint stops accepting connections and connected agents get a clean “start Vayu” error. Your choice persists across restarts."
						checked={enabled}
						onChange={(checked) => void toggleEnabled(checked)}
						disabled={isLoading || !hasElectron || !status}
					/>

					{/* Enabled but not listening - usually a port conflict. Offer a retry. */}
					{!isLoading && enabled && !running && (
						<Callout
							severity="warning"
							title="Enabled but not listening"
							action={
								<Button
									variant="outline"
									size="sm"
									onClick={() => void toggleEnabled(true)}
									className="h-7 px-2 text-xs shrink-0"
								>
									Retry
								</Button>
							}
						>
							the port may be in use.
						</Callout>
					)}

					<div className="flex items-center gap-2">
						<Label className="text-xs font-medium text-muted-foreground w-20 shrink-0">
							Endpoint
						</Label>
						<code className="flex-1 text-xs font-mono bg-muted rounded-md px-2 py-1.5 break-all">
							{endpoint}
						</code>
						<CopyButton text={endpoint} disabled={!hasEndpoint} />
					</div>

					{connectSnippets(endpoint).map((snippet) => (
						<div key={snippet.label} className="space-y-1.5">
							<div className="flex items-center justify-between">
								<span className="text-xs font-medium text-muted-foreground">
									{snippet.label}
								</span>
								<div className="flex items-center gap-1">
									{snippet.client && (
										<Button
											variant="outline"
											size="sm"
											onClick={() => void handleConnect(snippet.client!)}
											disabled={
												!hasElectron || !enabled || connecting !== null
											}
											className="h-7 px-2 text-xs shrink-0"
											title={
												enabled ? undefined : "Enable the MCP server first"
											}
										>
											{connecting === snippet.client ? (
												<Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
											) : (
												<Zap className="w-3.5 h-3.5 mr-1" />
											)}
											Connect
										</Button>
									)}
									<CopyButton text={snippet.code} disabled={!hasEndpoint} />
								</div>
							</div>
							<pre className="text-xs font-mono bg-muted rounded-md px-3 py-2 overflow-x-auto whitespace-pre">
								{snippet.code}
							</pre>
						</div>
					))}
				</CardContent>
			</Card>

			{/* Tools */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Wrench className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Tools</CardTitle>
					</div>
					<CardDescription>
						Choose which tools agents can use. A disabled tool is hidden from the
						agent's tool list and rejected if called anyway. The Write group has a
						second switch of its own - Write access, below - and a write tool needs
						both: leaving it on here does nothing while writes are off.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					{isLoading ? (
						<Skeleton className="h-24 w-full" />
					) : (
						toolGroups.map((cat) => {
							const catTools = cat.tools;
							const names = catTools.map((t) => t.name);
							const enabledCount = catTools.filter(
								(t) => !(config?.disabledTools ?? []).includes(t.name)
							).length;
							const allOn = enabledCount === catTools.length;
							return (
								<div key={cat.id}>
									<ToggleRow
										className="mb-2"
										label={
											<div className="flex items-center gap-2">
												<span className="text-sm font-semibold">
													{cat.label}
												</span>
												<span className="text-xs text-muted-foreground">
													{enabledCount}/{catTools.length} on
												</span>
											</div>
										}
										ariaLabel={`Enable all ${cat.label} tools`}
										description={cat.description}
										checked={allOn}
										onChange={(checked) => setToolsEnabled(names, checked)}
										disabled={!config}
										title="Toggle all in this group"
									/>
									<div className="space-y-1 border-l border-border pl-3">
										{catTools.map((tool) => {
											const on = !(config?.disabledTools ?? []).includes(
												tool.name
											);
											return (
												<ToggleRow
													key={tool.name}
													className="py-1"
													label={
														<code className="text-xs font-mono">
															{tool.name}
														</code>
													}
													ariaLabel={`Enable tool ${tool.name}`}
													description={tool.description}
													checked={on}
													onChange={(checked) =>
														setToolsEnabled([tool.name], checked)
													}
													disabled={!config}
												/>
											);
										})}
									</div>
								</div>
							);
						})
					)}
				</CardContent>
			</Card>

			{/* Allowlist */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Globe className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Target allowlist</CardTitle>
					</div>
					<CardDescription>
						Hosts an agent is permitted to send traffic to. Empty means no outbound
						requests are allowed - a safe default. Paste a URL or type a host; either is
						reduced to the host, so{" "}
						<code className="font-mono">https://api.example.com:8080/v1</code> and{" "}
						<code className="font-mono">api.example.com</code> are the same entry. The
						list is checked before Vayu sends anything, so a script an agent writes
						cannot reach around it: <code className="font-mono">pm.sendRequest</code> is
						refused entirely for requests an agent starts, and works normally when you
						Send from Vayu.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{/* Allow all hosts */}
					<ToggleRow
						label="Allow all hosts"
						description="Bypass the allowlist and let agents target any host. Reduces safety - leave off unless you trust the agent."
						checked={config?.allowAll ?? false}
						onChange={(checked) => void persist({ allowAll: checked })}
						disabled={!config}
					/>

					{config?.allowAll && (
						<Callout severity="warning" title="All hosts are allowed">
							the per-host list below is ignored until you turn this off.
						</Callout>
					)}

					<div
						className={cn(
							"space-y-3",
							config?.allowAll && "opacity-50 pointer-events-none select-none"
						)}
						aria-disabled={config?.allowAll ?? false}
					>
						<div className="flex items-center gap-2">
							<Input
								value={newHost}
								onChange={(e) => setNewHost(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										addHost();
									}
								}}
								placeholder="api.example.com"
								aria-label="Host to allow"
								className="max-w-xs"
								disabled={!config || config.allowAll}
							/>
							<Button
								variant="outline"
								size="sm"
								onClick={addHost}
								disabled={!config || config.allowAll || newHost.trim() === ""}
							>
								<Plus className="w-4 h-4 mr-1" />
								Add
							</Button>
						</div>

						{/* With no config there is no list to describe, so neither branch
						    below renders: "no hosts allowed yet" would be a claim about
						    data we never read. */}
						{isLoading ? (
							<Skeleton className="h-8 w-full" />
						) : config && config.allowlist.length > 0 ? (
							<div className="flex flex-wrap gap-2">
								{config.allowlist.map((host) => (
									<span
										key={host}
										className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 pl-2.5 pr-1 py-1 text-xs font-mono"
									>
										{host}
										<button
											onClick={() => removeHost(host)}
											className="rounded-md p-0.5 hover:bg-destructive/10 hover:text-destructive-text transition-colors"
											aria-label={`Remove ${host}`}
										>
											<X className="w-3.5 h-3.5" />
										</button>
									</span>
								))}
							</div>
						) : config ? (
							<p className="text-xs text-muted-foreground italic">
								No hosts allowed yet. Agents cannot send requests until you add one.
							</p>
						) : null}
					</div>
				</CardContent>
			</Card>

			{/* Load caps */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Gauge className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Load caps</CardTitle>
					</div>
					<CardDescription>
						Hard ceilings on agent-started load runs. A request over any cap is rejected
						before it reaches the engine, and each cap bounds only the runs that carry
						the field it names. A cap above the most Vayu itself will run is lowered to
						that maximum when you save it.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{CAP_FIELDS.map((field) =>
						isLoading ? (
							<Skeleton key={field.key} className="h-16 w-full" />
						) : (
							<NumberSettingRow
								key={field.key}
								label={field.label}
								description={field.description}
								value={config ? String(config[field.key]) : ""}
								// Blur, not every keystroke: each commit crosses IPC,
								// is re-sanitized by the main process and is applied to
								// the live server.
								commit="blur"
								onCommit={(next) => commitCap(field.key, next)}
								unit={field.unit}
								min="1"
								max={String(field.ceiling)}
								disabled={!config}
							/>
						)
					)}
				</CardContent>
			</Card>

			{/* Write access */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<ShieldCheck className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Write access</CardTitle>
					</div>
					<CardDescription>
						When off (default), agents can read and send requests but cannot change
						saved data: every tool in the Write group above refuses - creating, renaming
						and deleting collections and saved requests, and editing environments and
						engine config. Turning it on grants no tool you switched off in Tools; the
						two switches are separate, and a delete still asks you to confirm each time,
						stating how much a collection contains before it goes. Sending requests and
						load runs are unaffected either way - the allowlist and the caps govern
						those.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex items-center gap-3">
						<Switch
							checked={config?.allowWrites ?? false}
							onCheckedChange={(checked) => void persist({ allowWrites: checked })}
							disabled={!config}
							aria-label="Allow write operations"
						/>
						<Label className="text-sm text-muted-foreground">
							{config?.allowWrites ? "Writes enabled" : "Read-only"}
						</Label>
					</div>
				</CardContent>
			</Card>
		</>
	);
}

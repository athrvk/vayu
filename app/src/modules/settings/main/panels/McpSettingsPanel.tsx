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
 * See docs/engine/mcp.md and SECURITY.md.
 */

import { useCallback, useEffect, useState } from "react";
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

const DEFAULT_ENDPOINT = "http://127.0.0.1:9877/mcp";

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

/** Tool categories, in display order, with their sidebar copy. */
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

/** A small copy-to-clipboard button that flips to a check for a moment. */
function CopyButton({ text, className }: { text: string; className?: string }) {
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
	key: "maxRps" | "maxConcurrency" | "maxDurationSeconds";
	label: string;
	description: string;
}

const CAP_FIELDS: CapField[] = [
	{
		key: "maxRps",
		label: "Max RPS",
		description: "Ceiling on target requests/sec for a load run.",
	},
	{
		key: "maxConcurrency",
		label: "Max concurrency",
		description: "Ceiling on in-flight requests for a load run.",
	},
	{
		key: "maxDurationSeconds",
		label: "Max duration (seconds)",
		description: "Ceiling on how long a load run may last.",
	},
];

export default function McpSettingsPanel() {
	const hasElectron = typeof window !== "undefined" && !!window.electronAPI;

	const showToast = useToastStore((s) => s.showToast);

	const [status, setStatus] = useState<McpStatus | null>(null);
	const [config, setConfig] = useState<McpSafetyConfig | null>(null);
	const [tools, setTools] = useState<McpToolInfo[]>([]);
	const [newHost, setNewHost] = useState("");
	const [capDrafts, setCapDrafts] = useState<Partial<Record<CapField["key"], string>>>({});
	const [isLoading, setIsLoading] = useState(true);
	const [connecting, setConnecting] = useState<McpConnectClient | null>(null);

	// Load status + current safety config on mount.
	useEffect(() => {
		let cancelled = false;
		async function load() {
			if (!window.electronAPI) {
				setIsLoading(false);
				return;
			}
			try {
				const [s, c, t] = await Promise.all([
					window.electronAPI.getMcpStatus(),
					window.electronAPI.getMcpSafety(),
					window.electronAPI.getMcpTools(),
				]);
				if (cancelled) return;
				setStatus(s);
				setConfig(c);
				setTools(t);
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	// Re-check status when the user returns to the window — the server may have
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

	const endpoint = status?.url ?? DEFAULT_ENDPOINT;
	const running = status?.running ?? false;
	const enabled = status?.enabled ?? false;

	// Apply a change: main sanitizes + persists and returns the resolved config,
	// which we adopt as the new source of truth.
	const persist = useCallback(async (partial: Partial<McpSafetyConfig>) => {
		if (!window.electronAPI) return;
		const resolved = await window.electronAPI.updateMcpSafety(partial);
		setConfig(resolved);
	}, []);

	// Turn the MCP server on/off; main persists the preference and starts/stops
	// the server, returning the new status.
	const toggleEnabled = useCallback(async (next: boolean) => {
		if (!window.electronAPI) return;
		const s = await window.electronAPI.setMcpEnabled(next);
		setStatus(s);
	}, []);

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
						`The ${CLIENT_CLI[client]} CLI wasn't found — copy the snippet below to add Vayu manually.`,
						"error"
					);
				} else {
					showToast(res.message || `Couldn't connect ${CLIENT_LABEL[client]}.`, "error");
				}
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

	const commitCap = useCallback(
		(key: CapField["key"]) => {
			setCapDrafts((prev) => {
				const raw = prev[key];
				const next = { ...prev };
				delete next[key];
				if (raw !== undefined && config) {
					const n = parseInt(raw, 10);
					if (!Number.isNaN(n) && n > 0 && n !== config[key]) {
						void persist({ [key]: n });
					}
				}
				return next;
			});
		},
		[config, persist]
	);

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

			{/* Connection status + onboarding */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Plug className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Connection</CardTitle>
						{isLoading ? (
							<Skeleton className="h-5 w-16 ml-1" />
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
						Any agent connects to the already-running app with one command — no extra
						process to manage.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{/* Server on/off */}
					<div className="flex items-center justify-between gap-4 rounded-md border border-border bg-muted/30 px-3 py-2.5">
						<div>
							<Label className="text-sm">Enable MCP server</Label>
							<p className="text-xs text-muted-foreground mt-0.5">
								When off, the endpoint is unavailable and connected agents get a
								clean “start Vayu” error. Persists across restarts.
							</p>
						</div>
						<Switch
							checked={enabled}
							onCheckedChange={(checked) => void toggleEnabled(checked)}
							disabled={isLoading || !hasElectron}
							aria-label="Enable MCP server"
						/>
					</div>

					{/* Enabled but not listening — usually a port conflict. Offer a retry. */}
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
						<CopyButton text={endpoint} />
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
									<CopyButton text={snippet.code} />
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
						agent's tool list and rejected if called anyway.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					{isLoading ? (
						<Skeleton className="h-24 w-full" />
					) : (
						TOOL_CATEGORIES.map((cat) => {
							const catTools = tools.filter((t) => t.category === cat.id);
							if (catTools.length === 0) return null;
							const names = catTools.map((t) => t.name);
							const enabledCount = catTools.filter(
								(t) => !(config?.disabledTools ?? []).includes(t.name)
							).length;
							const allOn = enabledCount === catTools.length;
							return (
								<div key={cat.id}>
									<div className="flex items-center justify-between gap-4 mb-2">
										<div>
											<div className="flex items-center gap-2">
												<span className="text-sm font-semibold">
													{cat.label}
												</span>
												<span className="text-xs text-muted-foreground">
													{enabledCount}/{catTools.length} on
												</span>
											</div>
											<p className="text-xs text-muted-foreground mt-0.5">
												{cat.description}
											</p>
										</div>
										<Switch
											checked={allOn}
											onCheckedChange={(checked) =>
												setToolsEnabled(names, checked)
											}
											disabled={!config}
											title="Toggle all in this group"
										/>
									</div>
									<div className="space-y-1 border-l border-border pl-3">
										{catTools.map((tool) => {
											const on = !(config?.disabledTools ?? []).includes(
												tool.name
											);
											return (
												<div
													key={tool.name}
													className="flex items-center justify-between gap-4 py-1"
												>
													<div className="min-w-0">
														<code className="text-xs font-mono">
															{tool.name}
														</code>
														<p className="text-xs text-muted-foreground mt-0.5">
															{tool.description}
														</p>
													</div>
													<Switch
														checked={on}
														onCheckedChange={(checked) =>
															setToolsEnabled([tool.name], checked)
														}
														disabled={!config}
														aria-label={`Enable tool ${tool.name}`}
													/>
												</div>
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
						requests are allowed — a safe default. Add a host (no scheme or port), e.g.{" "}
						<code className="font-mono">api.example.com</code>.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{/* Allow all hosts */}
					<div className="flex items-center justify-between gap-4">
						<div>
							<Label className="text-sm">Allow all hosts</Label>
							<p className="text-xs text-muted-foreground mt-0.5">
								Bypass the allowlist and let agents target any host. Reduces safety
								— leave off unless you trust the agent.
							</p>
						</div>
						<Switch
							checked={config?.allowAll ?? false}
							onCheckedChange={(checked) => void persist({ allowAll: checked })}
							disabled={!config}
							aria-label="Allow all hosts"
						/>
					</div>

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
						) : (
							<p className="text-xs text-muted-foreground italic">
								No hosts allowed yet. Agents cannot send requests until you add one.
							</p>
						)}
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
						before it reaches the engine.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{CAP_FIELDS.map((field) => (
						<div key={field.key} className="flex items-center justify-between gap-4">
							<div>
								<Label className="text-sm">{field.label}</Label>
								<p className="text-xs text-muted-foreground mt-0.5">
									{field.description}
								</p>
							</div>
							{isLoading ? (
								<Skeleton className="h-9 w-28 shrink-0" />
							) : (
								<Input
									type="number"
									aria-label={field.label}
									min={1}
									value={
										capDrafts[field.key] ??
										(config ? String(config[field.key]) : "")
									}
									onChange={(e) =>
										setCapDrafts((prev) => ({
											...prev,
											[field.key]: e.target.value,
										}))
									}
									onBlur={() => commitCap(field.key)}
									onKeyDown={(e) => {
										if (e.key === "Enter") e.currentTarget.blur();
									}}
									className="w-28 shrink-0"
									disabled={!config}
								/>
							)}
						</div>
					))}
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
						When off (default), agents can read but not change saved data: the{" "}
						<code className="font-mono">create_request</code>,{" "}
						<code className="font-mono">update_environment</code>, and{" "}
						<code className="font-mono">update_engine_config</code> tools are disabled.
						This does not affect <code className="font-mono">run_request</code>,{" "}
						<code className="font-mono">run_collection_smoke</code>, or load runs, which
						are governed by the allowlist and caps.
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

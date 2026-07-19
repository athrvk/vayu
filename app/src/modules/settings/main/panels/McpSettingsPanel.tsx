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
	Plus,
	X,
	Check,
	Copy,
	CircleCheck,
	CircleSlash,
	AlertTriangle,
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
import type { McpSafetyConfig, McpStatus } from "@/types";
import { cn } from "@/lib/utils";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9877/mcp";

/** Config snippets an agent uses to connect to the running Vayu MCP endpoint. */
function connectSnippets(url: string): { label: string; code: string }[] {
	return [
		{
			label: "Claude Code",
			code: `claude mcp add --transport http vayu ${url}`,
		},
		{
			label: "Cursor · Claude Code (.mcp.json)",
			code: `{\n  "mcpServers": {\n    "vayu": { "type": "http", "url": "${url}" }\n  }\n}`,
		},
		{
			label: "Codex (~/.codex/config.toml)",
			code: `[mcp_servers.vayu]\nurl = "${url}"`,
		},
	];
}

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
					<Check className="w-3.5 h-3.5 mr-1 text-green-600 dark:text-green-400" />
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

	const [status, setStatus] = useState<McpStatus | null>(null);
	const [config, setConfig] = useState<McpSafetyConfig | null>(null);
	const [newHost, setNewHost] = useState("");
	const [capDrafts, setCapDrafts] = useState<Partial<Record<CapField["key"], string>>>({});
	const [isLoading, setIsLoading] = useState(true);

	// Load status + current safety config on mount.
	useEffect(() => {
		let cancelled = false;
		async function load() {
			if (!window.electronAPI) {
				setIsLoading(false);
				return;
			}
			try {
				const [s, c] = await Promise.all([
					window.electronAPI.getMcpStatus(),
					window.electronAPI.getMcpSafety(),
				]);
				if (cancelled) return;
				setStatus(s);
				setConfig(c);
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	const endpoint = status?.url ?? DEFAULT_ENDPOINT;
	const running = status?.running ?? false;

	// Apply a change: main sanitizes + persists and returns the resolved config,
	// which we adopt as the new source of truth.
	const persist = useCallback(async (partial: Partial<McpSafetyConfig>) => {
		if (!window.electronAPI) return;
		const resolved = await window.electronAPI.updateMcpSafety(partial);
		setConfig(resolved);
	}, []);

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

	return (
		<>
			{!hasElectron && (
				<Card className="border-amber-400/50 bg-amber-50/30 dark:bg-amber-950/10">
					<CardContent className="flex items-start gap-3 py-4">
						<AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
						<p className="text-sm text-muted-foreground">
							MCP settings are only available in the desktop app. Run Vayu via
							Electron to configure the MCP server.
						</p>
					</CardContent>
				</Card>
			)}

			{/* Connection status + onboarding */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Plug className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Connection</CardTitle>
						{isLoading ? (
							<Skeleton className="h-5 w-16 ml-1" />
						) : running ? (
							<Badge
								variant="secondary"
								className="ml-1 bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
							>
								<CircleCheck className="w-3 h-3 mr-1" />
								Running
							</Badge>
						) : (
							<Badge
								variant="secondary"
								className="ml-1 bg-muted text-muted-foreground"
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
					<div className="flex items-center gap-2">
						<Label className="text-xs font-medium text-muted-foreground w-20 shrink-0">
							Endpoint
						</Label>
						<code className="flex-1 text-xs font-mono bg-muted rounded px-2 py-1.5 break-all">
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
								<CopyButton text={snippet.code} />
							</div>
							<pre className="text-xs font-mono bg-muted rounded px-3 py-2 overflow-x-auto whitespace-pre">
								{snippet.code}
							</pre>
						</div>
					))}
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
							className="max-w-xs"
							disabled={!config}
						/>
						<Button
							variant="outline"
							size="sm"
							onClick={addHost}
							disabled={!config || newHost.trim() === ""}
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
										className="rounded p-0.5 hover:bg-destructive/10 hover:text-destructive transition-colors"
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

			{/* Writes */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<ShieldCheck className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Write access</CardTitle>
					</div>
					<CardDescription>
						When off (default), agents can read and run single requests, and load runs
						stay confirmation-gated. Turning this on permits collection/environment
						writes.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex items-center gap-3">
						<Switch
							checked={config?.allowWrites ?? false}
							onCheckedChange={(checked) => void persist({ allowWrites: checked })}
							disabled={!config}
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

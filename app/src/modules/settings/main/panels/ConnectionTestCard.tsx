/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ConnectionTestCard
 *
 * One send through the settings on this screen, reported as which hop answered
 * (issue #708). It exists because every other way of finding out that a proxy
 * URL is wrong, or that a corporate CA is missing, is a failed request in the
 * middle of doing something else - and the message there names the endpoint,
 * not the setting.
 *
 * A card in "Network & connectivity" rather than a button beside the proxy row:
 * the answer is about the whole transport policy - proxy, trust anchors and the
 * client certificate together - and pinning it to one row would suggest it only
 * tests that row.
 *
 * It also holds this screen's half of system-proxy resolution
 * (`useSystemProxyRefresh`), so the resolved row above it is true for someone
 * who is reading it right now.
 */

import { useState } from "react";
import { Loader2, PlugZap } from "lucide-react";

import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
} from "@/components/ui";
import { apiService } from "@/services/api";
import type { ConnectionTestOutcome, ConnectionTestResult } from "@/types";
import { cn } from "@/lib/utils";
import { useSystemProxyRefresh } from "../../useSystemProxyRefresh";

/**
 * What each outcome is called and how it reads.
 *
 * `variant="chip"` per the badge rule: these paint their own background, and
 * every other variant would keep its own `hover:bg-*` on top of it.
 */
const OUTCOME: Record<ConnectionTestOutcome, { label: string; chip: string; hint: string }> = {
	ok: {
		label: "Reached",
		chip: "bg-status-success-fill text-white",
		hint: "The request left this machine, crossed every hop and came back.",
	},
	proxy_failed: {
		label: "Proxy failed",
		chip: "bg-status-error-fill text-white",
		hint: "The proxy hop failed - the endpoint was never reached. Check the proxy setting above, and whether this network needs credentials in the proxy URL.",
	},
	tls_failed: {
		label: "TLS failed",
		chip: "bg-status-error-fill text-white",
		hint: "The connection was made and the certificate was not accepted. A TLS-inspecting proxy or an internal authority needs its certificate pasted into Custom CA Certificates above.",
	},
	timed_out: {
		label: "Timed out",
		chip: "bg-status-warning-fill text-white",
		hint: "Nothing answered in time. A proxy that silently drops traffic looks like this.",
	},
	failed: {
		label: "Failed",
		chip: "bg-status-error-fill text-white",
		hint: "The endpoint could not be reached. The proxy, if any, was not the thing that refused.",
	},
};

/** A URL that is plausibly reachable and belongs to nobody in particular. */
const DEFAULT_TEST_URL = "https://api.github.com/";

/** What the engine's `proxy` node means on screen, per mode. */
function proxyLine(proxy: ConnectionTestResult["proxy"]): string {
	if (proxy.url) return `Through ${proxy.url} (${proxy.mode})`;
	if (proxy.mode === "off") return "Sent direct - the proxy is switched off";
	if (proxy.mode === "environment")
		return "Whatever http_proxy and https_proxy name, which the engine does not read itself";
	if (proxy.mode === "system") return "Sent direct - nothing resolved from this system";
	return "Sent direct";
}

export function ConnectionTestCard() {
	useSystemProxyRefresh();

	const [url, setUrl] = useState(DEFAULT_TEST_URL);
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<ConnectionTestResult | null>(null);
	/** A test that could not be *run* - an unreachable engine, a refused URL. */
	const [failure, setFailure] = useState<string | null>(null);

	const run = async () => {
		setTesting(true);
		setResult(null);
		setFailure(null);
		try {
			setResult(await apiService.testConnection(url.trim()));
		} catch (error) {
			// Distinct from a failed connection, which comes back as a result:
			// this is the test itself not happening, and telling the user their
			// proxy is broken would be a lie.
			setFailure(
				error instanceof Error ? error.message : "The engine did not answer the test"
			);
		} finally {
			setTesting(false);
		}
	};

	const outcome = result ? OUTCOME[result.outcome] : null;

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<PlugZap className="w-5 h-5 text-muted-foreground" />
					<CardTitle>Connection test</CardTitle>
				</div>
				<CardDescription>
					Sends one request with the settings on this screen and reports which hop
					answered. A wrong proxy, a certificate this machine does not trust and an
					endpoint that is simply down all fail the same way in a request pane; here they
					do not.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor="connection-test-url">URL</Label>
					<div className="flex items-center gap-2">
						<Input
							id="connection-test-url"
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							placeholder="https://api.example.com/"
							className="font-mono text-xs"
						/>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={testing || url.trim() === ""}
							onClick={() => void run()}
						>
							{testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
							Test
						</Button>
					</div>
				</div>

				{failure && (
					<p className="text-sm text-status-error-text">
						The test could not be run: {failure}
					</p>
				)}

				{result && outcome && (
					<div className="surface-sunken rounded-md border border-rule p-3 space-y-2">
						<div className="flex items-center gap-2">
							<Badge variant="chip" className={cn("shrink-0", outcome.chip)}>
								{outcome.label}
							</Badge>
							{result.status !== undefined && (
								<span className="text-xs text-muted-foreground">
									HTTP {result.status}
								</span>
							)}
						</div>
						<p className="text-xs text-muted-foreground">{outcome.hint}</p>
						{result.detail && (
							<p className="text-xs font-mono break-all text-muted-foreground">
								{result.detail}
							</p>
						)}
						<p className="text-xs text-muted-foreground">{proxyLine(result.proxy)}</p>
						{result.clientCertificate && (
							<p className="text-xs text-muted-foreground">
								Presented the certificate registered for {result.clientCertificate}
							</p>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

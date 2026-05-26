
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ScriptTab
 *
 * Monaco-backed editor for a collection's pre- or post-request script.
 *
 * Composition order:
 *   - pre:  outer → inner → request (parent collection first, then child folders,
 *           then the request's own script)
 *   - post: request → inner → outer (request first, unwinding outward)
 *
 * Used by both the Pre-request and Post-request tabs in CollectionDetail.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import Editor from "@monaco-editor/react";
import { Badge, Button } from "@/components/ui";
import { useUpdateCollectionMutation } from "@/queries/collections";
import type { Collection } from "@/types";
import { InfoBanner } from "./shared";

type ScriptKind = "pre" | "post";

interface ScriptTabProps {
	collection: Collection;
	kind: ScriptKind;
}

const QUICK_REF: Array<[string, string]> = [
	["Environment", 'pm.environment.get("key")\npm.environment.set("key", val)'],
	["Globals", 'pm.globals.get("key")\npm.globals.set("key", val)'],
	["Collection vars", 'pm.collectionVariables.get("k")\npm.collectionVariables.set("k", v)'],
	["Response (post only)", "pm.response.json()\npm.response.code\npm.response.responseTime"],
];

export default function ScriptTab({ collection, kind }: ScriptTabProps) {
	const isPre = kind === "pre";
	const fieldKey = isPre ? "preRequestScript" : "postRequestScript";
	const initial = collection[fieldKey] ?? "";

	const [script, setScript] = useState(initial);
	const [showRef, setShowRef] = useState(false);
	const updateCollection = useUpdateCollectionMutation();

	useEffect(() => {
		setScript(collection[fieldKey] ?? "");
	}, [collection.id, collection, fieldKey]);

	const isDirty = script !== (collection[fieldKey] ?? "");

	const usedVars = useMemo(() => {
		const envPattern =
			/pm\.(?:environment|globals|collectionVariables)\.get\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		const templatePattern = /\{\{([^{}]+)\}\}/g;
		const fromGet = [...script.matchAll(envPattern)].map((m) => m[1]);
		const fromTpl = [...script.matchAll(templatePattern)].map((m) => m[1].trim());
		return [...new Set([...fromGet, ...fromTpl])];
	}, [script]);

	const handleSave = () => {
		if (!isDirty) return;
		updateCollection.mutate({ id: collection.id, [fieldKey]: script });
	};

	const handleClear = () => {
		setScript("");
	};

	return (
		<div className="max-w-[680px] flex flex-col gap-3.5">
			<InfoBanner>
				This script runs <strong>{isPre ? "before" : "after"} every request</strong> in this
				collection.{" "}
				{isPre
					? "Scripts compose outer→inner: the parent collection runs first, then child folders, then the request's own script."
					: "Scripts compose inner→outer: the request's script runs first, then its folder, then parent collections."}{" "}
				This enables centralized {isPre ? "auth refresh and pre-flight setup" : "shared test assertions and teardown"}.
			</InfoBanner>

			{usedVars.length > 0 && (
				<div className="flex flex-wrap gap-1.5 items-center">
					<span className="text-[11px] text-muted-foreground">References:</span>
					{usedVars.slice(0, 8).map((v) => (
						<Badge
							key={v}
							variant="secondary"
							className="font-mono text-[10px] bg-primary/10 text-variable border-0"
						>
							{`{{${v}}}`}
						</Badge>
					))}
					{usedVars.length > 8 && (
						<span className="text-[10px] text-muted-foreground">+{usedVars.length - 8} more</span>
					)}
				</div>
			)}

			<div className="border border-border rounded-md overflow-hidden">
				<div className="flex items-center gap-2.5 px-3 py-1.5 bg-panel border-b border-border">
					<span className="text-[11px] font-mono text-muted-foreground">
						{isPre ? "pre-request.js" : "post-request.js"}
					</span>
					<span className="ml-auto text-[10px] text-muted-foreground">JavaScript</span>
				</div>
				<Editor
					height="320px"
					language="javascript"
					value={script}
					onChange={(v) => setScript(v ?? "")}
					theme="vs-dark"
					options={{
						minimap: { enabled: false },
						fontSize: 12,
						lineNumbers: "on",
						scrollBeyondLastLine: false,
						wordWrap: "on",
						tabSize: 2,
						automaticLayout: true,
					}}
				/>
			</div>

			<div>
				<button
					type="button"
					onClick={() => setShowRef((s) => !s)}
					className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
				>
					{showRef ? (
						<ChevronDown className="w-3 h-3" />
					) : (
						<ChevronRight className="w-3 h-3" />
					)}
					Quick Reference
				</button>
				{showRef && (
					<div className="mt-2 grid grid-cols-2 gap-2">
						{QUICK_REF.map(([title, code]) => (
							<div key={title} className="bg-card border border-border rounded-md px-3 py-2.5">
								<div className="text-[10px] font-semibold text-muted-foreground mb-1.5">
									{title}
								</div>
								<pre className="m-0 text-[10px] leading-relaxed text-foreground font-mono whitespace-pre-wrap">
									{code}
								</pre>
							</div>
						))}
					</div>
				)}
			</div>

			<div className="flex gap-2">
				<Button
					onClick={handleSave}
					disabled={!isDirty || updateCollection.isPending}
					className="font-semibold"
				>
					{updateCollection.isPending ? "Saving…" : "Save Script"}
				</Button>
				<Button
					variant="outline"
					onClick={handleClear}
					disabled={!script || updateCollection.isPending}
				>
					Clear
				</Button>
			</div>
		</div>
	);
}

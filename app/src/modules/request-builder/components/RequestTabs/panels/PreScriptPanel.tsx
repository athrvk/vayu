
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * PreScriptPanel Component
 *
 * Pre-request script editor with variable preview
 */

import { useState } from "react";
import Editor from "@monaco-editor/react";
import { Button, Badge } from "@/components/ui";
import { useRequestBuilderContext } from "../../../context";

export default function PreScriptPanel() {
	const { request, updateField, getAllVariables } = useRequestBuilderContext();
	const [showVariables, setShowVariables] = useState(false);

	// Find variables referenced in script
	const envGetPattern =
		/pm\.(?:environment|globals|collectionVariables)\.get\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
	const templatePattern = /\{\{([^{}]+)\}\}/g;

	const envVars = [...request.preRequestScript.matchAll(envGetPattern)].map((m) => m[1]);
	const templateVars = [...request.preRequestScript.matchAll(templatePattern)].map((m) =>
		m[1].trim()
	);
	const usedVars = [...new Set([...envVars, ...templateVars])];

	const allVariables = getAllVariables();
	const hasReferencedVars = usedVars.length > 0;

	const handleChange = (value: string | undefined) => {
		updateField("preRequestScript", value || "");
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					Execute JavaScript before sending the request. Use the{" "}
					<code className="bg-muted px-1 rounded">pm</code> API.
				</p>
				{hasReferencedVars && (
					<Button
						size="sm"
						variant={showVariables ? "secondary" : "outline"}
						onClick={() => setShowVariables(!showVariables)}
					>
						{showVariables ? "Hide" : "Show"} Variables
					</Button>
				)}
			</div>

			{/* Referenced Variables */}
			{hasReferencedVars && !showVariables && (
				<div className="flex flex-wrap gap-2">
					<span className="text-xs text-muted-foreground">Referenced:</span>
					{usedVars.slice(0, 5).map((varName) => {
						const varInfo = allVariables[varName];
						return (
							<Badge
								key={varName}
								variant={varInfo ? "secondary" : "destructive"}
								className="font-mono text-xs"
							>
								{varName}
							</Badge>
						);
					})}
					{usedVars.length > 5 && (
						<span className="text-xs text-muted-foreground">
							+{usedVars.length - 5} more
						</span>
					)}
				</div>
			)}

			{/* All Variables Panel */}
			{showVariables && (
				<div className="p-3 bg-muted/50 rounded-md border border-input max-h-40 overflow-y-auto">
					<div className="grid grid-cols-2 gap-2 text-xs font-mono">
						{Object.entries(allVariables).map(([name, info]) => (
							<div key={name} className="flex items-center gap-2">
								<Badge variant="outline" className="text-[10px] px-1">
									{info.scope[0].toUpperCase()}
								</Badge>
								<span className="text-muted-foreground">{name}:</span>
								<span className="truncate">{info.value}</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Script Editor */}
			<div className="border border-input rounded-md overflow-hidden">
				<Editor
					height="350px"
					language="javascript"
					value={request.preRequestScript}
					onChange={handleChange}
					theme="vs-dark"
					options={{
						minimap: { enabled: false },
						fontSize: 13,
						lineNumbers: "on",
						scrollBeyondLastLine: false,
						wordWrap: "on",
						tabSize: 2,
						automaticLayout: true,
					}}
				/>
			</div>

			{/* Quick Reference */}
			<div className="text-xs text-muted-foreground space-y-1">
				<p className="font-medium">Quick Reference:</p>
				<code className="block bg-muted p-2 rounded">
					pm.environment.get("variable")
					<br />
					pm.environment.set("key", "value")
					<br />
					pm.globals.get("variable")
					<br />
					pm.collectionVariables.get("variable")
				</code>
			</div>
		</div>
	);
}

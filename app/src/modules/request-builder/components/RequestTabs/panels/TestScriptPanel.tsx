/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TestScriptPanel Component
 *
 * Test/post-request script editor.
 *
 * This and `PreScriptPanel` are the same panel bound to a different field: only
 * the field name, the opening sentence and the quick-reference block differ. The
 * duplication is known and deliberately left in place - it is small and stable,
 * and `script-panels.test.tsx` runs every assertion against both, so a fix
 * applied to one and not the other fails. Change them together.
 */

import { useState } from "react";
import { Button, Badge, CodeEditor, VariableScopeBadge } from "@/components/ui";
import { useRequestBuilderContext } from "../../../context";
import InheritedScriptsNotice from "./InheritedScriptsNotice";
import LegacyScriptNotice from "./LegacyScriptNotice";

export default function TestScriptPanel() {
	const { request, updateField, getAllVariables, inheritedPostScripts, legacyPostScript } =
		useRequestBuilderContext();
	const [showVariables, setShowVariables] = useState(false);

	// Find variables referenced in script
	const envGetPattern =
		/pm\.(?:environment|globals|collectionVariables)\.get\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
	const templatePattern = /\{\{([^{}]+)\}\}/g;

	const envVars = [...request.testScript.matchAll(envGetPattern)].map((m) => m[1]);
	const templateVars = [...request.testScript.matchAll(templatePattern)].map((m) => m[1].trim());
	const usedVars = [...new Set([...envVars, ...templateVars])];

	const allVariables = getAllVariables();
	const hasReferencedVars = usedVars.length > 0;

	const handleChange = (value: string) => {
		updateField("testScript", value);
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					Execute JavaScript after receiving the response. Use{" "}
					<code className="bg-muted px-1 rounded-md">pm.test()</code> for assertions.
				</p>
				{hasReferencedVars && (
					<Button
						size="sm"
						variant={showVariables ? "secondary" : "outline"}
						onClick={() => setShowVariables(!showVariables)}
					>
						{showVariables ? "Hide" : "Show"} all variables
					</Button>
				)}
			</div>

			{/* `entries` wins when the caller supplied them - a copy of a past run
			    lists what that run recorded, not what the collection reads now. */}
			<InheritedScriptsNotice
				variant="post"
				collectionId={request.collectionId}
				entries={inheritedPostScripts}
			/>

			<LegacyScriptNotice variant="post" script={legacyPostScript} />

			{/*
			 * The referenced list stays put when the full list opens. "Show
			 * Variables" used to replace it, so the button promising more
			 * information removed the more useful half - the names this script
			 * actually mentions, and whether each one resolves - and gave back an
			 * unfiltered dump of everything in scope. The two answer different
			 * questions, so both are shown and the button names the one it opens.
			 */}
			{hasReferencedVars && (
				<div className="flex flex-wrap items-center gap-2">
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

			{/*
			 * `VariableScopeBadge`, not a hand-rolled outline badge printing
			 * `scope[0]`. The primitive is where the scope colours live, and this
			 * panel bypassed it - so global, collection and environment all read as
			 * the same colourless chip, in the one place a script author comes to
			 * tell them apart.
			 */}
			{showVariables && (
				<div className="p-3 bg-muted/50 rounded-md border border-input max-h-40 overflow-y-auto">
					<div className="grid grid-cols-2 gap-2 text-xs font-mono">
						{Object.entries(allVariables).map(([name, info]) => (
							<div key={name} className="flex items-center gap-2">
								<VariableScopeBadge scope={info.scope} variant="compact" />
								<span className="text-muted-foreground">{name}:</span>
								<span className="truncate">{info.value}</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Script Editor */}
			<div className="rounded-md border border-input overflow-hidden">
				<CodeEditor
					height="350px"
					language="javascript"
					value={request.testScript}
					onChange={handleChange}
				/>
			</div>

			{/* Quick Reference */}
			<div className="text-xs text-muted-foreground space-y-1">
				<p className="font-medium">Quick Reference:</p>
				<code className="block bg-muted p-2 rounded-md">
					pm.test("Test name", () =&gt; {"{"}
					<br />
					&nbsp;&nbsp;pm.response.to.have.status(200);
					<br />
					{"}"});
					<br />
					<br />
					pm.response.json()
					<br />
					pm.response.text()
					<br />
					pm.response.headers.get("Content-Type")
				</code>
			</div>
		</div>
	);
}

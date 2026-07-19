/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * EditorPanel
 *
 * Code-editor behavior — font size, word wrap, minimap, line numbers, tab
 * width. Applies to every Monaco instance (scripts, request/response bodies)
 * via the shared CodeEditor wrapper. Client-side only. The code font family
 * lives under Appearance alongside the UI font.
 */

import { Code2, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { useClientSettingsStore } from "@/stores";
import { EDITOR_FONT_SIZES, EDITOR_TAB_SIZES } from "@/constants/client-settings";
import { MONO_FONTS } from "@/constants/appearance";
import { CodeEditor } from "@/components/ui/code-editor";
import { OptionButtons, ToggleRow } from "./SettingControls";
import { cn } from "@/lib/utils";

// Tab-indented (real \t) + nested so changing the tab width visibly reflows the
// indentation in the read-only preview below.
// Glyph-rich one-liner shown under each code-font choice. Lowercase g/a, the
// zero, i/l/1, and the => ligature are where monospace faces differ most.
const MONO_SAMPLE = "fn(0) => {a_g}";

const SAMPLE = [
	"function greet(name) {",
	"\tif (!name) {",
	'\t\treturn "Hello, world!";',
	"\t}",
	"\treturn `Hello, ${name}!`;",
	"}",
].join("\n");

export default function EditorPanel() {
	const editor = useClientSettingsStore((s) => s.editor);
	const setEditor = useClientSettingsStore((s) => s.setEditor);
	const monoFont = useClientSettingsStore((s) => s.monoFont);
	const setMonoFont = useClientSettingsStore((s) => s.setMonoFont);

	return (
		<>
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Code2 className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Editor</CardTitle>
					</div>
					<CardDescription>
						Applies to every code editor in the app — scripts and request/response
						bodies.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<div>
						<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
							Code font
						</p>
						<div className="grid grid-cols-2 gap-3">
							{MONO_FONTS.map((option) => {
								const isSelected = monoFont === option.value;
								return (
									<button
										key={option.value}
										onClick={() => setMonoFont(option.value)}
										className={cn(
											"relative flex flex-col items-start gap-1 p-3 rounded-lg border-2 text-left transition-all",
											"hover:bg-accent hover:border-accent-foreground/20",
											isSelected
												? "border-primary bg-primary/5"
												: "border-border"
										)}
									>
										<span className="text-sm font-medium">{option.label}</span>
										<span className="text-xs text-muted-foreground">
											{option.description}
										</span>
										{/* Glyph-rich sample rendered in the font so the faces
										    are visibly distinct (0/O, i/l/1, ligatures, arrows). */}
										<span
											className="mt-1.5 text-[15px] leading-tight text-foreground"
											style={{ fontFamily: option.stack }}
										>
											{MONO_SAMPLE}
										</span>
										{isSelected && (
											<CheckCircle2 className="w-4 h-4 text-primary absolute top-2 right-2" />
										)}
									</button>
								);
							})}
						</div>
					</div>

					<div>
						<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
							Font size
						</p>
						<OptionButtons
							options={EDITOR_FONT_SIZES.map((v) => ({ value: v, label: `${v}px` }))}
							value={editor.fontSize}
							onChange={(fontSize) => setEditor({ fontSize })}
						/>
					</div>

					<div>
						<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
							Tab width
						</p>
						<OptionButtons
							options={EDITOR_TAB_SIZES.map((v) => ({
								value: v,
								label: `${v} spaces`,
							}))}
							value={editor.tabSize}
							onChange={(tabSize) => setEditor({ tabSize })}
							columns="grid-cols-2"
						/>
					</div>

					<div className="space-y-3 pt-1">
						<ToggleRow
							label="Word wrap"
							description="Wrap long lines instead of scrolling horizontally"
							checked={editor.wordWrap}
							onChange={(wordWrap) => setEditor({ wordWrap })}
						/>
						<ToggleRow
							label="Line numbers"
							checked={editor.lineNumbers}
							onChange={(lineNumbers) => setEditor({ lineNumbers })}
						/>
						<ToggleRow
							label="Minimap"
							description="Show the code overview on the right edge"
							checked={editor.minimap}
							onChange={(minimap) => setEditor({ minimap })}
						/>
					</div>
				</CardContent>
			</Card>

			{/* Live preview — reflects the settings above (font, wrap, line numbers,
			    minimap, tab width) and the code font. */}
			<Card>
				<CardHeader className="pb-3">
					<CardTitle className="text-base">Preview</CardTitle>
					<CardDescription>
						A live sample using your current editor settings.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="h-48 overflow-hidden rounded-md border border-border">
						<CodeEditor value={SAMPLE} language="javascript" readOnly />
					</div>
				</CardContent>
			</Card>
		</>
	);
}

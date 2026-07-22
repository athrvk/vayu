/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * EditorPanel
 *
 * Code-editor behavior - font size, word wrap, minimap, line numbers, tab
 * width. Applies to every Monaco instance (scripts, request/response bodies)
 * via the shared CodeEditor wrapper. Client-side only. The code font family
 * lives under Appearance alongside the UI font.
 */

import { Code2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { useClientSettingsStore } from "@/stores";
import { EDITOR_FONT_SIZES, EDITOR_TAB_SIZES } from "@/constants/client-settings";
import { MONO_FONTS, customMonoStack, type MonoFontChoice } from "@/constants/appearance";
import { CodeEditor } from "@/components/ui/code-editor";
import { OptionButtons, ToggleRow } from "./SettingControls";
import { FontPicker } from "./FontPicker";

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
	const monoFontCustom = useClientSettingsStore((s) => s.monoFontCustom);
	const setMonoFontCustom = useClientSettingsStore((s) => s.setMonoFontCustom);

	return (
		<>
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Code2 className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Editor</CardTitle>
					</div>
					<CardDescription>
						Applies to every code editor in the app - scripts and request/response
						bodies.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<div>
						<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
							Code font
						</p>
						<FontPicker
							options={MONO_FONTS}
							value={monoFont}
							onChange={(v) => setMonoFont(v as MonoFontChoice)}
							customValue={monoFontCustom}
							onCustomChange={setMonoFontCustom}
							sample={MONO_SAMPLE}
							customStack={customMonoStack}
							placeholder="e.g. Cascadia Code, Comic Mono"
						/>
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

			{/* Live preview - reflects the settings above (font, wrap, line numbers,
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

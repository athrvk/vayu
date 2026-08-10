/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * AppearancePanel
 *
 * Cosmetic app preferences: theme mode, accent color scheme, and interface
 * (font / scale / roundedness). Client-side only (localStorage-backed), so
 * there's no Save button - changes apply live. Rendered inside
 * {@link ClientSettingsPanel} by the app-settings registry.
 */

import {
	Monitor,
	Sun,
	Moon,
	SunMoon,
	CheckCircle2,
	SwatchBook,
	Type,
	Maximize2,
	Squircle,
} from "lucide-react";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Eyebrow,
	Kbd,
	Skeleton,
} from "@/components/ui";
import { useElectronTheme, type ThemeSource } from "@/hooks/useElectronTheme";
import { useAppearance } from "@/hooks/useAppearance";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useClientSettingsStore } from "@/stores";
import { COLOR_SCHEMES } from "@/constants/color-schemes";
import {
	DEFAULT_UI_SCALE,
	UI_FONTS,
	UI_RADII,
	UI_SCALE_MAX,
	UI_SCALE_MIN,
	UI_SCALE_STEP,
	customSansStack,
	formatScale,
	type UiFontChoice,
} from "@/constants/appearance";
import { cn } from "@/lib/utils";
import { modKey } from "@/lib/platform";
import { ToggleRow } from "./SettingControls";
import { FontPicker } from "./FontPicker";

// Vayu-flavored preview: an HTTP method, path, status, and latency - mixed case
// and digits so the face's letterforms still read clearly.
const UI_FONT_SAMPLE = "GET /users · 200 OK · 45ms";

export default function AppearancePanel() {
	const { themeSource, setTheme, colorScheme, setColorScheme, isDark, isLoading } =
		useElectronTheme();
	const { font, setFont, fontCustom, setFontCustom, scale, setScale, radius, setRadius } =
		useAppearance();
	const reducedMotion = useClientSettingsStore((s) => s.reducedMotion);
	const osReducesMotion = usePrefersReducedMotion();
	const setReducedMotion = useClientSettingsStore((s) => s.setReducedMotion);

	const themeOptions: {
		value: ThemeSource;
		label: string;
		icon: typeof Sun;
		description: string;
	}[] = [
		{
			value: "system",
			label: "System",
			icon: Monitor,
			description: "Follow your operating system's theme",
		},
		{
			value: "light",
			label: "Light",
			icon: Sun,
			description: "Always use light theme",
		},
		{
			value: "dark",
			label: "Dark",
			icon: Moon,
			description: "Always use dark theme",
		},
	];

	return (
		<>
			{/* Theme Mode Selection */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<SunMoon className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Theme Mode</CardTitle>
					</div>
					<CardDescription>Choose between light, dark, or system theme.</CardDescription>
				</CardHeader>
				<CardContent>
					{isLoading ? (
						<div className="flex gap-3">
							<Skeleton className="h-24 flex-1" />
							<Skeleton className="h-24 flex-1" />
							<Skeleton className="h-24 flex-1" />
						</div>
					) : (
						<div className="grid grid-cols-3 gap-3">
							{themeOptions.map((option) => {
								const Icon = option.icon;
								const isSelected = themeSource === option.value;
								return (
									<button
										key={option.value}
										onClick={() => setTheme(option.value)}
										className={cn(
											"relative flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-colors",
											"hover:bg-accent hover:border-accent-foreground/20",
											isSelected
												? "border-primary bg-primary/5"
												: "border-border"
										)}
									>
										<div
											className={cn(
												"w-10 h-10 rounded-full flex items-center justify-center",
												isSelected
													? "bg-primary-fill text-primary-foreground"
													: "bg-muted text-muted-foreground"
											)}
										>
											<Icon className="w-5 h-5" />
										</div>
										<div className="text-center">
											<p
												className={cn(
													"text-sm font-medium",
													isSelected && "text-primary"
												)}
											>
												{option.label}
											</p>
											<p className="text-xs text-muted-foreground mt-0.5">
												{option.description}
											</p>
										</div>
										{isSelected && (
											<CheckCircle2 className="w-4 h-4 text-primary absolute top-2 right-2" />
										)}
									</button>
								);
							})}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Color Scheme Selection */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<SwatchBook className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Color Scheme</CardTitle>
					</div>
					<CardDescription>
						Choose your preferred accent color. This affects buttons, highlights, and
						primary UI elements.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{isLoading ? (
						<div className="grid grid-cols-3 gap-3">
							<Skeleton className="h-28" />
							<Skeleton className="h-28" />
							<Skeleton className="h-28" />
							<Skeleton className="h-28" />
							<Skeleton className="h-28" />
							<Skeleton className="h-28" />
						</div>
					) : (
						<div className="grid grid-cols-3 gap-3">
							{COLOR_SCHEMES.map((option) => {
								const Icon = option.icon;
								const isSelected = colorScheme === option.value;
								return (
									<button
										key={option.value}
										onClick={() => setColorScheme(option.value)}
										className={cn(
											"relative flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-colors",
											"hover:bg-accent hover:border-accent-foreground/20",
											isSelected
												? "border-primary bg-primary/5"
												: "border-border"
										)}
									>
										<div className="flex items-center gap-2">
											{/* Swatch derives from the scheme's own accent
											    token so it can never drift from reality.
											    data-color-scheme (+ dark) scopes --primary
											    to this scheme regardless of the active one. */}
											<div
												data-color-scheme={option.value}
												className={cn(
													"w-8 h-8 rounded-full flex items-center justify-center bg-primary-fill",
													isDark && "dark",
													isSelected &&
														"ring-2 ring-offset-2 ring-primary ring-offset-background"
												)}
											>
												<Icon className="w-4 h-4 text-primary-foreground" />
											</div>
										</div>
										<div className="text-center">
											<p
												className={cn(
													"text-sm font-medium",
													isSelected && "text-primary"
												)}
											>
												{option.label}
											</p>
											<p className="text-xs text-muted-foreground mt-0.5">
												{option.description}
											</p>
										</div>
										{isSelected && (
											<CheckCircle2 className="w-4 h-4 text-primary absolute top-2 right-2" />
										)}
									</button>
								);
							})}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Interface - font + scale + roundedness */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Type className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Interface</CardTitle>
					</div>
					<CardDescription>
						Choose the interface font and how large the app is drawn.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<div>
						<Eyebrow className="mb-2">Font</Eyebrow>
						<FontPicker
							options={UI_FONTS}
							value={font}
							onChange={(v) => setFont(v as UiFontChoice)}
							customValue={fontCustom}
							onCustomChange={setFontCustom}
							sample={UI_FONT_SAMPLE}
							customStack={customSansStack}
							placeholder="e.g. Söhne, SF Pro, Segoe UI"
						/>
					</div>

					<div>
						<Eyebrow className="mb-2 flex items-center gap-1.5">
							<Maximize2 className="w-3.5 h-3.5" />
							Scale
						</Eyebrow>
						<div className="flex items-center gap-3">
							<input
								id="ui-scale"
								type="range"
								min={UI_SCALE_MIN * 100}
								max={UI_SCALE_MAX * 100}
								step={UI_SCALE_STEP * 100}
								value={Math.round(scale * 100)}
								onChange={(e) => setScale(Number(e.target.value) / 100)}
								aria-label="Interface scale"
								className="w-full accent-primary"
							/>
							<span className="w-11 shrink-0 text-right text-sm font-mono tabular-nums">
								{formatScale(scale)}
							</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setScale(DEFAULT_UI_SCALE)}
								disabled={scale === DEFAULT_UI_SCALE}
							>
								Reset
							</Button>
						</div>
						<p className="text-xs text-muted-foreground mt-2">
							Zooms the whole interface. <Kbd size="sm">{modKey}</Kbd>{" "}
							<Kbd size="sm">+</Kbd> / <Kbd size="sm">-</Kbd> / <Kbd size="sm">0</Kbd>{" "}
							change this same setting. Code font size is a separate control in Editor
							settings.
						</p>
					</div>

					<div>
						<Eyebrow className="mb-2 flex items-center gap-1.5">
							<Squircle className="w-3.5 h-3.5" />
							Roundedness
						</Eyebrow>
						<div className="grid grid-cols-3 gap-3">
							{UI_RADII.map((option) => {
								const isSelected = radius === option.value;
								return (
									<button
										key={option.value}
										onClick={() => setRadius(option.value)}
										className={cn(
											"relative flex flex-col items-start gap-1.5 p-3 rounded-lg border-2 text-left transition-colors",
											"hover:bg-accent hover:border-accent-foreground/20",
											isSelected
												? "border-primary bg-primary/5"
												: "border-border"
										)}
									>
										<span
											className="h-6 w-9 border-2 border-muted-foreground/40 bg-muted"
											style={{ borderRadius: option.radius }}
											aria-hidden
										/>
										<span className="text-sm font-medium">{option.label}</span>
										<span className="text-xs text-muted-foreground">
											{option.description}
										</span>
										{isSelected && (
											<CheckCircle2 className="w-4 h-4 text-primary absolute top-2 right-2" />
										)}
									</button>
								);
							})}
						</div>
					</div>

					<div className="border-t border-border pt-4">
						<ToggleRow
							label="Reduced motion"
							description="Minimize animations and transitions across the app"
							checked={reducedMotion}
							onChange={setReducedMotion}
						/>
						{osReducesMotion && (
							/*
							 * Without this the row reads "off" while the app is in
							 * fact not animating, and the only honest explanation
							 * lives outside Vayu. The switch stays interactive
							 * because it still means something: turning it on keeps
							 * motion reduced if the system preference later changes.
							 */
							<p className="mt-2 text-xs text-muted-foreground">
								Your system already asks for reduced motion, so Vayu is minimizing
								animations regardless of this setting.
							</p>
						)}
					</div>
				</CardContent>
			</Card>
		</>
	);
}

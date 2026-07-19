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
 * there's no Save button — changes apply live. Rendered inside
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
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Skeleton,
} from "@/components/ui";
import { useElectronTheme, type ThemeSource } from "@/hooks/useElectronTheme";
import { useAppearance } from "@/hooks/useAppearance";
import { useClientSettingsStore } from "@/stores";
import { COLOR_SCHEMES } from "@/constants/color-schemes";
import { UI_FONTS, UI_SCALES, UI_RADII, MONO_FONTS } from "@/constants/appearance";
import { cn } from "@/lib/utils";

export default function AppearancePanel() {
	const { themeSource, setTheme, colorScheme, setColorScheme, isDark, isLoading } =
		useElectronTheme();
	const { font, setFont, scale, setScale, radius, setRadius } = useAppearance();
	const monoFont = useClientSettingsStore((s) => s.monoFont);
	const setMonoFont = useClientSettingsStore((s) => s.setMonoFont);

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
											"relative flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all",
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
											"relative flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all",
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

			{/* Interface — font + scale + roundedness */}
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
						<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
							Font
						</p>
						<div className="grid grid-cols-2 gap-3">
							{UI_FONTS.map((option) => {
								const isSelected = font === option.value;
								return (
									<button
										key={option.value}
										onClick={() => setFont(option.value)}
										className={cn(
											"relative flex flex-col items-start gap-1 p-3 rounded-lg border-2 text-left transition-all",
											"hover:bg-accent hover:border-accent-foreground/20",
											isSelected
												? "border-primary bg-primary/5"
												: "border-border"
										)}
									>
										<span
											className="text-sm font-medium"
											style={{ fontFamily: option.stack }}
										>
											{option.label}
										</span>
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
										<span
											className="text-sm font-medium"
											style={{ fontFamily: option.stack }}
										>
											{option.label}
										</span>
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

					<div>
						<p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
							<Maximize2 className="w-3.5 h-3.5" />
							Scale
						</p>
						<div className="grid grid-cols-3 gap-3">
							{UI_SCALES.map((option) => {
								const isSelected = scale === option.value;
								return (
									<button
										key={option.value}
										onClick={() => setScale(option.value)}
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
										{isSelected && (
											<CheckCircle2 className="w-4 h-4 text-primary absolute top-2 right-2" />
										)}
									</button>
								);
							})}
						</div>
					</div>

					<div>
						<p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
							<Squircle className="w-3.5 h-3.5" />
							Roundedness
						</p>
						<div className="grid grid-cols-3 gap-3">
							{UI_RADII.map((option) => {
								const isSelected = radius === option.value;
								return (
									<button
										key={option.value}
										onClick={() => setRadius(option.value)}
										className={cn(
											"relative flex flex-col items-start gap-1.5 p-3 rounded-lg border-2 text-left transition-all",
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
				</CardContent>
			</Card>
		</>
	);
}

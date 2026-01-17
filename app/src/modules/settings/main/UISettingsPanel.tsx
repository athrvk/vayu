
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UI Settings Panel
 *
 * Handles client-side appearance settings (theme, etc.)
 * This is separate from engine configs as it's app-level, not engine-level.
 */

import {
	Monitor,
	Sun,
	Moon,
	Palette,
	CheckCircle2,
	Circle,
	Cloud,
	Waves,
	Trees,
	Sunset,
	Sparkles,
	Heart,
} from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Skeleton,
} from "@/components/ui";
import { useElectronTheme, type ThemeSource, type ColorScheme } from "@/hooks/useElectronTheme";
import { cn } from "@/lib/utils";

export default function UISettingsPanel() {
	const { themeSource, setTheme, colorScheme, setColorScheme, isLoading } = useElectronTheme();

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

	const colorSchemeOptions: {
		value: ColorScheme;
		label: string;
		icon: typeof Cloud;
		description: string;
		color: string;
	}[] = [
		{
			value: "sky",
			label: "Sky",
			icon: Cloud,
			description: "Calm and airy",
			color: "bg-sky-500",
		},
		{
			value: "ocean",
			label: "Ocean",
			icon: Waves,
			description: "Deep and professional",
			color: "bg-blue-500",
		},
		{
			value: "forest",
			label: "Forest",
			icon: Trees,
			description: "Fresh and natural",
			color: "bg-green-500",
		},
		{
			value: "sunset",
			label: "Sunset",
			icon: Sunset,
			description: "Warm and energetic",
			color: "bg-orange-500",
		},
		{
			value: "aurora",
			label: "Aurora",
			icon: Sparkles,
			description: "Magical and modern",
			color: "bg-purple-500",
		},
		{
			value: "coral",
			label: "Coral",
			icon: Heart,
			description: "Vibrant and lively",
			color: "bg-rose-500",
		},
	];

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Header */}
			<div className="border-b border-border px-6 py-4 shrink-0">
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-xl font-semibold">Appearance</h1>
						<p className="text-sm text-muted-foreground mt-1">
							Customize the look and feel of the application
						</p>
					</div>
				</div>
			</div>

			{/* Settings Content */}
			<div className="flex-1 overflow-auto p-6">
				<div className="grid gap-6 max-w-3xl">
					{/* Theme Mode Selection */}
					<Card>
						<CardHeader className="pb-3">
							<div className="flex items-center gap-2">
								<Palette className="w-5 h-5 text-muted-foreground" />
								<CardTitle className="text-base">Theme Mode</CardTitle>
							</div>
							<CardDescription>
								Choose between light, dark, or system theme.
							</CardDescription>
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
															? "bg-primary text-primary-foreground"
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
								<Circle className="w-5 h-5 text-muted-foreground" />
								<CardTitle className="text-base">Color Scheme</CardTitle>
							</div>
							<CardDescription>
								Choose your preferred accent color. This affects buttons,
								highlights, and primary UI elements.
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
									{colorSchemeOptions.map((option) => {
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
													<div
														className={cn(
															"w-8 h-8 rounded-full flex items-center justify-center",
															option.color,
															isSelected &&
																"ring-2 ring-offset-2 ring-primary ring-offset-background"
														)}
													>
														<Icon className="w-4 h-4 text-white" />
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
				</div>
			</div>
		</div>
	);
}

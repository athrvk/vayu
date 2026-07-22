/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Copy and download, the pair that sits at the right of a response tab strip.
 *
 * Duplicated between `ResponseViewer` and `UnifiedResponseViewer`: same two
 * buttons, same icons, same tick-for-a-moment feedback. The copies had already
 * drifted three ways, and each difference is a real one rather than an accident
 * of transcription, so all three are **props** here instead of a winner picked
 * between them:
 *
 *   - **What gets copied.** The request builder copies the formatted body; the
 *     history viewer prefers `bodyRaw` and falls back. Caller decides.
 *   - **What the file is called.** The request builder names it after the
 *     detected body type; history always used `.txt`, and has to keep doing so -
 *     `ResponseData` has no `bodyType` field at all, so unifying on it would
 *     have produced `response-1234.undefined` on every history download.
 *   - **How long the tick lasts.** One used `TIMING.STATUS_RESET_MS`, the other
 *     a literal `2000`. Equal today, which is exactly why it would have drifted
 *     unnoticed. The shared constant wins; it is not a per-caller concern.
 */

import { useState } from "react";
import { Copy, Check, Download } from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";
import { TIMING } from "@/config/timing";

export interface ResponseActionsProps {
	/** The text to copy and to download. */
	content: string;
	/**
	 * Extension for the downloaded file, without the dot. Defaults to `txt`
	 * because that is what a caller with no detected type should get - never
	 * `undefined`.
	 */
	fileExtension?: string;
	className?: string;
}

export function ResponseActions({ content, fileExtension, className }: ResponseActionsProps) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(content);
		setCopied(true);
		setTimeout(() => setCopied(false), TIMING.STATUS_RESET_MS);
	};

	const handleDownload = () => {
		const blob = new Blob([content], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		// Stamped at click time, not render time.
		a.download = `response-${Date.now()}.${fileExtension || "txt"}`;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className={cn("flex items-center gap-1 shrink-0", className)}>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						size="icon"
						variant="ghost"
						onClick={handleCopy}
						aria-label="Copy response"
					>
						{copied ? (
							// The only feedback that the copy happened.
							<Check className="w-4 h-4 text-status-success-text" />
						) : (
							<Copy className="w-4 h-4" />
						)}
					</Button>
				</TooltipTrigger>
				<TooltipContent>Copy response</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						size="icon"
						variant="ghost"
						onClick={handleDownload}
						aria-label="Download response"
					>
						<Download className="w-4 h-4" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>Download response</TooltipContent>
			</Tooltip>
		</div>
	);
}

export default ResponseActions;

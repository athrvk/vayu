/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseBody Component
 *
 * Displays HTTP response body with multiple view modes:
 * - Pretty: Formatted/syntax highlighted view (default)
 * - Raw: Unformatted text view
 * - Preview: HTML rendering (when applicable)
 *
 * Similar to Postman's response body viewer. A body that is not text (an
 * image, a PDF, other bytes) has no modes: an image is drawn from its bytes,
 * and the rest say what they are and how big. Those bytes are `rawBytes`, the
 * decoded base64 the engine sent for a body that is not UTF-8 (issue #2458).
 *
 * Past `LARGE_BODY_BYTES` it drops to one mode: no `formatBody`, no syntax
 * highlighting, and a prefix of the raw body in the editor, with a notice
 * saying so. Everything this component does to a body it does synchronously
 * during render, so a multi-megabyte response used to freeze the window between
 * Send and the pane painting. See the constant in `utils.ts` for the passes and
 * why 2MB.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileCode, Image as ImageIcon, File, Eye, Code, FileText } from "lucide-react";
import { CodeEditor, ToggleGroup, ToggleGroupItem } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Callout } from "../Callout";
import {
	detectBodyType,
	getMonacoLanguage,
	formatBody,
	formatSize,
	LARGE_BODY_BYTES,
} from "./utils";
import { buildPreviewDocument } from "./preview-document";
import type { BodyType, ResponseBodyProps, ViewMode } from "./types";
import {
	contentTypeOf,
	type DecodeNotice,
	type ResponseBytes,
} from "@/modules/request-builder/utils/response-bytes";

interface ExtendedResponseBodyProps extends ResponseBodyProps {
	/** Default view mode */
	defaultMode?: ViewMode;
	/** Height for the editor (use "100%" for flex containers) */
	height?: string;
	/** Show view mode toggle buttons */
	showModeToggle?: boolean;
	/**
	 * Rendered at the end of the toolbar - copy and download, in the request
	 * builder. A slot rather than a hardcoded `ResponseActions` because the
	 * history viewer mounts this same component with nothing to put there.
	 */
	actions?: ReactNode;
}

export default function ResponseBody({
	body,
	bodyRaw,
	rawBytes,
	headers,
	className,
	defaultMode = "pretty",
	height = "100%",
	showModeToggle = true,
	actions,
}: ExtendedResponseBodyProps) {
	const [viewMode, setViewMode] = useState<ViewMode>(defaultMode);

	/*
	 * Past `LARGE_BODY_BYTES` the pane stops formatting and shows a raw prefix.
	 * Whichever of the two strings is bigger decides, because either can end up
	 * in the editor - `body` in Pretty, `bodyRaw` in Raw - and the cost is the
	 * one that gets rendered, not the one that was passed first.
	 */
	const bodyLength = Math.max(body.length, bodyRaw?.length ?? 0);
	const isLargeBody = bodyLength > LARGE_BODY_BYTES;

	/*
	 * Detect body type from content and headers.
	 *
	 * Above the gate the *content* half is skipped, because it is itself a pass
	 * over the whole string: with no content-type header - or a generic
	 * `text/plain` one - `detectBodyType` trims the body, `JSON.parse`s it and
	 * lower-cases it looking for markup, which for a 32MB body is the freeze
	 * this threshold exists to prevent, paid before the gate below is even
	 * reached. The header still decides where there is one; an unlabelled large
	 * body reads as text, which is what the pane renders it as either way.
	 */
	const detectedType = useMemo(() => {
		const declared = detectBodyType(headers, isLargeBody ? "" : bodyRaw || body);
		// Bytes with no text view never reach the editor, whatever the header
		// says: the funnel already decided there is no text (`isText`).
		if (rawBytes && !rawBytes.isText) return isNonTextType(declared) ? declared : "binary";
		return declared;
	}, [headers, bodyRaw, body, isLargeBody, rawBytes]);

	const canPreview = detectedType === "html";

	// Format body for display
	// Raw mode: use bodyRaw (original raw bytes from server) if available, fallback to body
	// Pretty mode: use formatted body
	const formattedBody = useMemo(() => {
		// The gate, and the reason the toggle is hidden with it: there is one
		// view left, so `formatBody`'s indent pass never runs and the
		// editor is handed a bounded prefix rather than a model it will spend
		// seconds tokenising.
		if (isLargeBody) return (bodyRaw || body).slice(0, LARGE_BODY_BYTES);
		if (viewMode === "raw") {
			// Use bodyRaw for raw view to show actual server response
			return bodyRaw || body;
		}
		return formatBody(body, detectedType);
	}, [body, bodyRaw, detectedType, viewMode, isLargeBody]);

	// Get Monaco language
	const language = useMemo(() => getMonacoLanguage(detectedType), [detectedType]);

	// Raw rather than formatted, so the preview is the document the server sent.
	// Never built above the gate: the toggle that selects Preview is hidden
	// there, and the build is another whole-string copy.
	const previewHtml = useMemo(
		() =>
			detectedType === "html" && !isLargeBody ? buildPreviewDocument(bodyRaw || body) : "",
		[body, bodyRaw, detectedType, isLargeBody]
	);

	const contentType = contentTypeOf(headers);

	if (isNonTextType(detectedType)) {
		return (
			<div className={cn("flex-1 flex flex-col h-full", className)}>
				<BodyToolbar label={detectedType}>{actions}</BodyToolbar>
				<NonTextBody
					type={detectedType}
					rawBytes={rawBytes}
					text={bodyRaw || body}
					contentType={contentType}
					canDownload={Boolean(actions)}
				/>
			</div>
		);
	}

	return (
		<div className={cn("flex-1 flex flex-col h-full", className)}>
			<BodyToolbar label={detectedType}>
				{showModeToggle && !isLargeBody && (
					<ToggleGroup
						value={viewMode}
						// Radix clears the value when the active item is pressed again.
						// A view mode has no "off" - ignore the empty string rather than
						// letting the body render nothing.
						onValueChange={(next) => next && setViewMode(next as ViewMode)}
						// Always `xs`, never `sm`: this toolbar's row
						// is `h-band` (32px), but `sm`'s track (`h-control`
						// 28px plus `p-1` padding, 34px total) is taller than that - it
						// overflowed the band's own border once #1679 made `sm` a flat
						// 28px instead of a `--spacing`-derived value that happened to
						// fit. `xs`'s track (`h-control-sm` 24px plus `p-0.5`, 27px) is
						// the one size that actually clears it.
						size="xs"
						aria-label="Body view mode"
					>
						<ToggleGroupItem value="pretty">
							<Code className="size-icon-sm" />
							Pretty
						</ToggleGroupItem>
						<ToggleGroupItem value="raw">
							<FileText className="size-icon-sm" />
							Raw
						</ToggleGroupItem>
						{canPreview && (
							<ToggleGroupItem value="preview">
								<Eye className="size-icon-sm" />
								Preview
							</ToggleGroupItem>
						)}
					</ToggleGroup>
				)}
				{actions}
			</BodyToolbar>

			{/*
			 * Said here rather than in either viewer, because this is the
			 * component that made the decision: it is the pane's own limit, not
			 * something the engine or the store did to the response. The
			 * separate "the engine only read this much" notice lives in the
			 * request builder's viewer and both can be on screen at once.
			 *
			 * Download is promised only when there is a Download button - the
			 * history viewer mounts this with no `actions` slot.
			 */}
			{isLargeBody && (
				<div className="shrink-0 px-4 pt-3">
					<Callout severity="info" title="Large response">
						This body is {formatSize(bodyLength)}. Formatting is off and only the first{" "}
						{formatSize(LARGE_BODY_BYTES)} is shown here, so the pane stays responsive.
						{actions ? " Download saves the body the app received." : ""}
					</Callout>
				</div>
			)}
			{rawBytes?.notice && (
				<div className="shrink-0 px-4 pt-3">
					<DecodeNoticeCallout notice={rawBytes.notice} canDownload={Boolean(actions)} />
				</div>
			)}

			{/* Content */}
			<div className="flex-1 min-h-0">
				{!isLargeBody && viewMode === "preview" && detectedType === "html" ? (
					// The markup is the server's, so the frame takes no sandbox token:
					// `allow-same-origin` with `allow-scripts` hands it the renderer's
					// origin and `window.parent.electronAPI`, and `allow-scripts` alone
					// still runs whatever it ships. The policy and inert links come from
					// `buildPreviewDocument`. `preview-sandbox.test.tsx` holds the string.
					<iframe
						srcDoc={previewHtml}
						className="w-full h-full bg-white"
						sandbox=""
						title="HTML preview"
					/>
				) : (
					<CodeEditor
						height={height}
						// Plaintext above the gate too: tokenising a 2MB model for
						// syntax colours is the third of the three passes the
						// threshold exists to avoid.
						language={isLargeBody || viewMode === "raw" ? "plaintext" : language}
						ariaLabel="Response body"
						value={formattedBody}
						readOnly
					/>
				)}
			</div>
		</div>
	);
}

/**
 * The toolbar sits on a 32px band.
 *
 * It was `px-4 py-2` around `h-7` segments - 44px, against a 24px tab
 * strip directly above it. `ResponseActions` carries a comment saying
 * its icons are `h-6` precisely so they share that 24px row; this
 * toolbar never got the same treatment and ran 83% taller than the
 * band it hangs under. `h-8` with no vertical padding is the same
 * construction the tab row uses, one step up so the hierarchy still
 * reads.
 *
 * **No background of its own**, which is the second thing that was
 * wrong here and the harder one to see. It was `bg-muted/20`; the fix
 * for that was `surface-sunken`, and that over-corrected - a full
 * `--muted` fill turns this row into a heavy grey band between a
 * card-coloured tab strip and a card-coloured editor, reading as a
 * separate block wedged between them rather than part of the pane.
 *
 * The rule problem `surface-sunken` was solving does not need a fill to
 * solve. This row sits inside the pane, which declares `surface-card`,
 * so `border-b border-rule` already resolves against a card - exactly
 * how the tab strip above gets its edge, with no background either.
 * The band is defined by its rule and its height, not by a colour.
 *
 * `h-band` (issue #1679), not the bare `h-8` this comment already
 * claimed was 32px: under the 3px spacing rhythm `--spacing` moved to
 * for #1670, `h-8` resolves to 24px, level with the tab strip rather
 * than a step above it - a comment describing an intent the class had
 * stopped delivering. `--spacing-band` is the floor that does not ride
 * density, the same one the tab strip and drawer header use.
 */
function BodyToolbar({ label, children }: { label: string; children?: ReactNode }) {
	return (
		<div className="flex h-band items-center justify-between gap-2 px-4 border-b border-rule">
			<div className="flex items-center gap-2">
				{/* `size-icon-sm`, matching the tab row's icons. It was 16px. */}
				<FileCode className="size-icon-sm text-muted-foreground" />
				<span className="text-label text-muted-foreground uppercase tracking-[0.06em]">
					{label}
				</span>
			</div>
			<div className="flex items-center gap-2">{children}</div>
		</div>
	);
}

const NON_TEXT_TYPES: ReadonlySet<BodyType> = new Set(["image", "pdf", "binary"]);

function isNonTextType(type: BodyType): type is "image" | "pdf" | "binary" {
	return NON_TEXT_TYPES.has(type);
}

/** The text on screen is not a faithful reading of the bytes; say which way. */
function DecodeNoticeCallout({
	notice,
	canDownload,
}: {
	notice: DecodeNotice;
	canDownload: boolean;
}) {
	const download = canDownload ? " Download saves the exact bytes." : "";
	const replaced = notice.replaced
		? ` Bytes that aren't valid ${notice.charset} appear as \uFFFD.`
		: "";
	if (notice.unknownLabel) {
		return (
			<Callout severity="warning" title={`Unknown charset "${notice.unknownLabel}"`}>
				{`This body is shown as ${notice.charset} instead.${replaced}${download}`}
			</Callout>
		);
	}
	return (
		<Callout severity="warning" title="Some bytes didn't decode">
			{`${replaced.trim()}${download}`}
		</Callout>
	);
}

/**
 * An image, a PDF or other bytes: what it is, how big, and the image itself.
 * The bytes are `rawBytes` when the engine sent base64, else the UTF-8 text it
 * sent, which is then exactly those bytes.
 */
function NonTextBody({
	type,
	rawBytes,
	text,
	contentType,
	canDownload,
}: {
	type: "image" | "pdf" | "binary";
	rawBytes: ResponseBytes | undefined;
	text: string;
	contentType: string;
	canDownload: boolean;
}) {
	const bytes = useMemo(() => rawBytes?.data ?? new TextEncoder().encode(text), [rawBytes, text]);
	const size = formatSize(bytes.length);
	const download = canDownload ? " Download saves it." : "";

	return (
		<div className="flex-1 flex items-center justify-center p-4 surface-sunken">
			<div className="text-center space-y-4">
				<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-rule text-sm text-muted-foreground">
					{type === "image" && <ImageIcon className="size-icon" />}
					{type === "pdf" && <File className="size-icon" />}
					{type === "binary" && <FileCode className="size-icon" />}
					<span>
						{type === "image" &&
							`Image (${contentType.split(/[/;+]/)[1]?.toUpperCase() || "image"}), ${size}`}
						{type === "pdf" && `PDF document, ${size}`}
						{type === "binary" && `Binary data, ${size}`}
					</span>
				</div>
				{type === "image" ? (
					<div className="max-w-full max-h-[400px] overflow-auto">
						<ImagePreview bytes={bytes} contentType={contentType} />
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						{type === "pdf"
							? "PDF preview isn't available here."
							: "This body isn't text."}
						{download}
					</p>
				)}
			</div>
		</div>
	);
}

/**
 * The image, from an object URL over its own bytes, revoked when they change
 * or the preview unmounts. Set on the element in the effect rather than held in
 * state, so a StrictMode remount creates a fresh URL instead of keeping the one
 * its first cleanup revoked.
 */
function ImagePreview({
	bytes,
	contentType,
}: {
	bytes: Uint8Array<ArrayBuffer>;
	contentType: string;
}) {
	const ref = useRef<HTMLImageElement>(null);
	useEffect(() => {
		const img = ref.current;
		if (!img) return;
		const url = URL.createObjectURL(new Blob([bytes], { type: contentType || "image/png" }));
		img.src = url;
		return () => {
			img.removeAttribute("src");
			URL.revokeObjectURL(url);
		};
	}, [bytes, contentType]);

	return <img ref={ref} alt="Response" className="max-w-full h-auto border border-rule" />;
}

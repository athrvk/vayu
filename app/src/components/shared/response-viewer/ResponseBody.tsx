/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The response body with view modes, Pretty (formatted, highlighted; the default), Raw (as
 * received) and Preview (HTML, when applicable), as Postman's viewer has. A body that is not text
 * (an image, a PDF, other bytes) has no modes: an image is drawn from its bytes, the rest say what
 * and how big, those bytes being `rawBytes`, the decoded base64 the engine sent for a non-UTF-8
 * body (#2458). Past `LARGE_BODY_BYTES` it keeps one mode: no `formatBody`, no highlighting, a raw
 * prefix in the editor with a notice, as everything here runs synchronously in render and a
 * multi-megabyte response would freeze the window (the constant in `utils.ts` has the passes and
 * why 2MB). The request builder's Raw tab (`RawRequestResponse`) caps its copy alike, with the same
 * notice.
 */

import { useMemo, useState, type ReactNode } from "react";
import { FileCode, Image as ImageIcon, File, Eye, Code, FileText } from "lucide-react";
import { CodeEditor, ToggleGroup, ToggleGroupItem } from "@/components/ui";
import { formatBytes } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { Callout } from "../Callout";
import { detectBodyType, getMonacoLanguage, formatBody, LARGE_BODY_BYTES } from "./utils";
import { LargeBodyNotice } from "./LargeBodyNotice";
import { ImagePreview } from "./ImagePreview";
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
	 * The toolbar's end slot (copy and download in the request builder); a slot, as the history
	 * viewer mounts this with nothing there.
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
	 * Past `LARGE_BODY_BYTES` the pane shows a raw prefix. The bigger string decides, as either can
	 * reach the editor (`body` in Pretty, `bodyRaw` in Raw), and the cost is the rendered one.
	 */
	const bodyLength = Math.max(body.length, bodyRaw?.length ?? 0);
	const isLargeBody = bodyLength > LARGE_BODY_BYTES;

	/*
	 * The body type from content and headers. Above the gate the *content* half is skipped, being a
	 * whole-string pass itself: without a content-type (or with `text/plain`) `detectBodyType`
	 * trims, `JSON.parse`s and lower-cases the body, the freeze the gate prevents, paid before the
	 * gate. The header still decides where present; an unlabelled large body reads as text, as
	 * rendered anyway.
	 */
	const detectedType = useMemo(() => {
		const declared = detectBodyType(headers, isLargeBody ? "" : bodyRaw || body);
		// Bytes without a text view never reach the editor, whatever the header: the funnel decided
		// (`isText`).
		if (rawBytes && !rawBytes.isText) return isNonTextType(declared) ? declared : "binary";
		// A binary header over a body sent as UTF-8 (no `rawBytes`, or `isText`) is text
		// mislabelled (#3427): readable, so the editor shows it. Image and PDF keep their pane.
		return declared === "binary" ? "text" : declared;
	}, [headers, bodyRaw, body, isLargeBody, rawBytes]);

	const canPreview = detectedType === "html";

	// Raw shows `bodyRaw`, the server's bytes, falling back to `body`; Pretty the formatted body.
	const formattedBody = useMemo(() => {
		// The gate, and why the toggle hides with it: one view remains, so `formatBody`'s indent
		// pass never runs and the editor gets a bounded prefix instead of a model it tokenises for
		// seconds.
		if (isLargeBody) return (bodyRaw || body).slice(0, LARGE_BODY_BYTES);
		if (viewMode === "raw") {
			// Use bodyRaw for raw view to show actual server response
			return bodyRaw || body;
		}
		return formatBody(body, detectedType);
	}, [body, bodyRaw, detectedType, viewMode, isLargeBody]);

	// Get Monaco language
	const language = useMemo(() => getMonacoLanguage(detectedType), [detectedType]);

	// Raw, not formatted, so the preview is the server's document; never built above the gate,
	// where the Preview toggle is hidden and the build is another whole-string copy.
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
						// Radix clears the value when the active item is pressed again; a view mode
						// has no "off", so the empty string is ignored rather than rendering
						// nothing.
						onValueChange={(next) => next && setViewMode(next as ViewMode)}
						// Always `xs`: the toolbar row is `h-band` (32px), and `sm`'s track
						// (`h-control` 28px plus `p-1`, 34px) overflows its border, `sm` being a
						// flat 28px (#1679); `xs`'s (`h-control-sm` 24px plus `p-0.5`, 27px) clears
						// it.
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
			 * Download is promised only with a Download button: the history viewer has no `actions`
			 * slot.
			 */}
			{isLargeBody && (
				<LargeBodyNotice
					bodyLength={bodyLength}
					formattingOff
					downloadNote={actions ? "Download saves the body the app received." : undefined}
				/>
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
					// `allow-same-origin` with `allow-scripts` hands it the renderer's origin and
					// `window.parent.electronAPI`, and `allow-scripts` alone runs whatever it
					// ships. The policy and inert links come from `buildPreviewDocument`;
					// `preview-sandbox.test.tsx` holds the string.
					<iframe
						srcDoc={previewHtml}
						className="w-full h-full bg-white"
						sandbox=""
						title="HTML preview"
					/>
				) : (
					<CodeEditor
						height={height}
						// Plaintext above the gate: tokenising a 2MB model for colour is the third
						// pass the threshold avoids.
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
 * The toolbar sits on a 32px band: `h-band` (#1679), the floor that does not ride density, as the
 * tab strip and drawer header use, a step above the 24px tab strip (a bare `h-8` is 24px under
 * #1670's 3px `--spacing`). **No background of its own**: a full `--muted` fill makes it a heavy
 * grey band wedged between a card-coloured tab strip and editor. The pane declares `surface-card`,
 * so `border-b border-rule` already resolves against a card, as the tab strip's edge does without a
 * background: the band is its rule and height, not a colour.
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
 * An image, a PDF or other bytes: what it is, how big, and the image itself. The bytes are
 * `rawBytes` for base64, else the UTF-8 text, then exactly those bytes.
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
	const size = formatBytes(bytes.length);
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

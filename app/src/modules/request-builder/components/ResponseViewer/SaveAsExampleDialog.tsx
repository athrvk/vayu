/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Name-and-confirm for "save this response as an example" (#588), at `StartMockServerDialog`'s
 * scale: one field, the facts the save carries, the engine's refusal shown in the form. It asks for
 * a name since the name is all the Examples panel lists, and "200 OK" three times is unreadable.
 * The mutation lives here, unlike `StartMockServerDialog` (whose parent owns a toast and a switch):
 * success here only closes, and `ResponseViewer`, which redraws every send, needs no query client
 * for a modal's feature.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
	Button,
	Dialog,
	DialogContent,
	DialogBody,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	DialogCancelButton,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { formatBytes } from "@/lib/format-number";
import { useCreateRequestExampleMutation } from "@/queries";
import { isCommitEnter } from "@/lib/keyboard";
import { defaultExampleName, exampleFromResponse } from "./save-as-example";
import { cappedReadExtent, heldBodySize } from "../../utils/response-bytes";
import type { ResponseState } from "../../types";

export interface SaveAsExampleDialogProps {
	/** The saved request the example is nested under. */
	requestId: string;
	/** The response being kept - status, headers, body, and its truncation. */
	response: ResponseState;
	/**
	 * Mounted only while open, like `StartMockServerDialog`: the mount is the reset, so the name
	 * starts from this response's status line, never the last attempt or its error.
	 */
	onClose: () => void;
}

export function SaveAsExampleDialog({ requestId, response, onClose }: SaveAsExampleDialogProps) {
	const [name, setName] = useState(() => defaultExampleName(response));
	const save = useCreateRequestExampleMutation();

	const trimmed = name.trim();
	const pending = save.isPending;
	const canSave = trimmed.length > 0 && !pending;

	const onSave = () => {
		if (!canSave) return;
		save.mutate(
			{ requestId, example: exampleFromResponse(response, trimmed) },
			{ onSuccess: onClose }
		);
	};

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Save response as example</DialogTitle>
					<DialogDescription>
						Kept against this request with its status, headers and body
						{response.sentRequest && ", and the request that produced it"} - the same
						shape an import stores, and what a mock server for this collection can
						answer with.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-4 py-2">
					<div className="space-y-1">
						<Label htmlFor="example-name" className="leading-snug">
							Name
							<span className="block text-xs font-normal text-muted-foreground">
								What the Examples tab lists this response as.
							</span>
						</Label>
						<Input
							id="example-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								if (isCommitEnter(e)) onSave();
							}}
							aria-invalid={trimmed.length === 0}
							autoFocus
						/>
					</div>

					{/*
					 * A restored run's body may be only the slice the engine kept
					 * (`maxTraceBodyBytes`), and a mock serves an example as a whole response. Said
					 * before the save; afterwards the row's "Partial body" chip is all the panel
					 * shows.
					 */}
					{response.bodyTruncated && (
						<Callout severity="warning" title="This body is not the whole response">
							Only the first {formatBytes(heldBodySize(response))} of{" "}
							{formatBytes(response.bodyBytes ?? heldBodySize(response))} was kept
							when the run was stored, and that is what gets saved. Re-send the
							request first to keep the complete body.
						</Callout>
					)}

					{/*
					 * The other partial body, not exclusive with the above (#3422): the engine
					 * stopped reading at `maxDesignResponseBodyBytes`, so a re-send reads the same
					 * and the remedy is the setting, as in the viewer's notice.
					 */}
					{response.bodyCapped && (
						<Callout severity="warning" title="This body was capped while reading">
							Only {cappedReadExtent(response)} of this response was read -
							Vayu&apos;s engine stops a Send there, so re-sending reads the same
							amount, and that is what gets saved. Raise Max Send response body in
							Settings to read more.
						</Callout>
					)}

					{/*
					 * The ordering contract, where the save happens: a mock answers with a matched
					 * route's first example, an append never takes that position, and a running
					 * mock reloads nothing until restarted.
					 */}
					<p className="text-xs text-muted-foreground">
						Added after the request&apos;s existing examples, so a mock server keeps
						answering with the same one. A running mock picks this up when it is
						restarted.
					</p>

					{save.error && (
						<Callout severity="blocking" title="Couldn't save the example">
							{save.error.message}
						</Callout>
					)}
				</DialogBody>

				<DialogFooter>
					<DialogCancelButton onClick={onClose} />
					<Button onClick={onSave} disabled={!canSave}>
						{pending && (
							<Loader2 className="size-icon animate-spin" aria-hidden="true" />
						)}
						Save example
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export default SaveAsExampleDialog;

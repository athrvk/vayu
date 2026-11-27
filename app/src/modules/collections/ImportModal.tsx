/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
	Upload,
	CheckCircle2,
	X,
	Folder,
	FolderOpen,
	Layers,
	Globe,
	AlertTriangle,
	FileWarning,
	Link2,
} from "lucide-react";
import {
	Button,
	Checkbox,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	Input,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	TabLabel,
	Textarea,
	LabelSwap,
	DialogCancelButton,
	ICON_MOTION,
	TooltipIconButton,
} from "@/components/ui";
import { useImportModalStore, useTabsStore, useToastStore, type ImportReport } from "@/stores";
import { useImportMutation } from "@/queries/import";
import { useCollectionsQuery } from "@/queries/collections";
import { queryKeys } from "@/queries/keys";
import { useSetActiveEnvironmentMutation } from "@/queries/environments";
import { useBoundSpecReader } from "@/queries/specs";
import {
	matchBoundSpecs,
	specCandidates,
	type SpecReimportMatch,
} from "@/services/openapi/bound-spec-match";
import SpecReimportDialog from "./SpecReimportDialog";
import { apiService } from "@/services/api";
import { type CollectionDraft, type ImportResult } from "@/services/importers/types";
import type { ImportMcpDiffMatch } from "@/types";
import { draftSiblings } from "@/services/importers/draft-siblings";
import {
	unselectedCertificateCount,
	withCertificateTicked,
} from "@/services/importers/client-certificate-selection";
import { describeCarriedOver, describeCounts, importResultNotices } from "./import-notices";
import { NoticeList } from "./NoticeList";
import { ImportClientCertificates } from "./ImportClientCertificates";
import { ImportMcpForm } from "./ImportMcpForm";
import { canConnectMcp, emptyMcpForm, existingMcpImports, mcpImportRequest } from "./import-mcp";
import { McpReimportDiff } from "./McpReimportDiff";
import { announceImport, buildImportReport } from "./import-report";
import { activateImportedEnvironment } from "./import-environment";
import { ImportFileFolders } from "./ImportFileFolders";
import { importFailureMessage } from "@/services/importers/failure-message";
import {
	applicableEntries,
	detectBatch,
	entryLabel,
	isImportableFileName,
	mcpBatchEntry,
	reparseBatch,
	type BatchDocument,
	type BatchEntry,
} from "@/services/importers/batch";
import { useSpecDocumentLimit } from "@/hooks/useSpecDocumentLimit";
import { fileBaseName } from "@/lib/file-path";
import { IMPORT_MCP_FORMAT } from "@/constants/import";
import { ImportProgressView, type ImportProgress } from "./ImportProgressView";
import { Callout, MethodBadge, FieldError } from "@/components/shared";
import { isCommitEnter } from "@/lib/keyboard";
import { pluralize } from "@/modules/dashboard/utils/format";
import { useNewRequest } from "@/hooks/useNewRequest";
import { CollectionPicker } from "@/modules/welcome/components/CollectionPicker";
import { importCommand, type CommandImport } from "@/services/curl/parseCurl";
import { pasteNotices } from "@/modules/request-builder/utils/paste-disclosure";
import { presetFromCommand } from "./curl-request-preset";

/** The dialog's sources, in tab order. */
const TABS = ["file", "url", "paste", "mcp"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
	file: "File",
	url: "URL",
	paste: "Paste",
	mcp: "MCP server",
};
type Phase = "idle" | "detecting" | "preview" | "error";

/**
 * What one tab is showing and doing (issue #893).
 *
 * `entries`: one row per picked document, in pick order (issue #666). A single file is a list of
 * one, so the URL and Paste tabs (single by construction) take the batch path, not a second one
 * beside it. Each entry carries its own bundled text, parse and apply outcome; nothing is derived
 * from another file's.
 *
 * `progress`: what this tab is doing now, or null while it waits on the user (issue #882). `phase`
 * cannot carry it: `detecting` covers a download, a `$ref` walk and N engine parses alike.
 */
interface TabState {
	phase: Phase;
	error: string;
	entries: BatchEntry[];
	progress: ImportProgress | null;
}

const IDLE_TAB: TabState = { phase: "idle", error: "", entries: [], progress: null };

const FORMAT_BADGES = [
	"Postman v2.1",
	"Postman v2.0",
	"Postman environment",
	"Postman globals",
	"Insomnia v4",
	"Insomnia v5",
	"OpenAPI 3.0",
	"OpenAPI 2.0",
	"JMeter .jmx",
];

export function ImportModal() {
	const isOpen = useImportModalStore((s) => s.isOpen);
	const close = useImportModalStore((s) => s.close);
	const importMutation = useImportMutation();
	const setActiveEnvironment = useSetActiveEnvironmentMutation();
	const queryClient = useQueryClient();
	const { data: collections = [] } = useCollectionsQuery();
	const readBoundSpecs = useBoundSpecReader();
	const openCollectionSpecTab = useTabsStore((s) => s.openCollectionSpecTab);
	const showToast = useToastStore((s) => s.showToast);
	const { newRequest, pickerProps } = useNewRequest();

	const [tab, setTab] = useState<Tab>("file");
	/**
	 * Every tab's state, side by side (issue #893). A tab's work belongs to the tab: one shared
	 * state cleared on a tab switch clears the display, not the work, so a URL fetch landing later
	 * writes its preview under whichever tab is showing. Every async writer patches the tab it
	 * *started on*, not the active one (see `patchTab`).
	 */
	const [tabs, setTabs] = useState<Record<Tab, TabState>>(() => ({
		file: IDLE_TAB,
		url: IDLE_TAB,
		paste: IDLE_TAB,
		mcp: IDLE_TAB,
	}));
	const [pasteText, setPasteText] = useState("");
	/** The Paste tab's text when it is a curl/wget command, which is not a collection (#2250). */
	const [pastedCommand, setPastedCommand] = useState<CommandImport | null>(null);
	const [url, setUrl] = useState("");
	/** The MCP tab's fields, the bearer token among them: state here and nowhere else. */
	const [mcpForm, setMcpForm] = useState(emptyMcpForm);
	const [importEnvironments, setImportEnvironments] = useState(true);
	const [importScripts, setImportScripts] = useState(true);
	/**
	 * The documents in this import that a collection already binds, while the
	 * fork is on screen; `null` when it is not (issue #680).
	 */
	const [reimports, setReimports] = useState<SpecReimportMatch[] | null>(null);
	/**
	 * The bound-document lookup is a round trip (see `handleImport`). Dialog-wide, not per tab: it
	 * gates the apply, of which only one can be in flight, and the fork it leads to is a modal over
	 * this dialog, so no tab can be switched to while it runs.
	 */
	const [checkingBindings, setCheckingBindings] = useState(false);
	/**
	 * An apply is under way: the bound-document lookup or the writes. Read by the close, the apply
	 * guard, the Import button and the option toggles (issue #895). A toggle supersedes the tab
	 * while the apply holds a generation captured before its first file went out, so a toggle
	 * mid-apply would drop the outcome write that reports which files failed. Nor could a toggle
	 * change anything then: `runImport` sends each file with the values it started with.
	 */
	const applying = importMutation.isPending || checkingBindings;
	const fileInputRef = useRef<HTMLInputElement>(null);
	const folderInputRef = useRef<HTMLInputElement>(null);
	const { maxBytes: specMaxBytes } = useSpecDocumentLimit();

	/**
	 * Which run of each tab is current (issue #893). A generation rather than an abort path per
	 * stage, because the writes are what must stop and there are five kinds: the fetch, the detect,
	 * the MCP connect, an option re-parse and the apply's outcomes. Each captures its tab's number at the start and
	 * drops its patch if the number has moved (the dialog closed or the tab was reset), so a parse
	 * finishing after a close cannot write a preview into the state the dialog next opens with.
	 *
	 * A ref, not state: async work must read the current value, not the one its closure captured.
	 */
	const generation = useRef<Record<Tab, number>>({ file: 0, url: 0, paste: 0, mcp: 0 });
	/**
	 * Each tab's in-flight call's cancel. The generation stops the writes; this stops the wait: the
	 * engine keeps talking to an MCP server until its own bound.
	 * Only the URL download and the MCP connect have one: they are the stages that go on costing
	 * after nobody is listening (the engine reads the rest of a 10 MB document either way).
	 */
	const inFlight = useRef<Partial<Record<Tab, AbortController>>>({});

	const active = tabs[tab];
	const { phase, error, entries, progress } = active;

	/**
	 * Write into one tab's slice, unless that tab has moved on. Always functional: the tabs are
	 * sibling keys of one record and their writers overlap (a URL download's progress tick lands
	 * while a File pick is mid-parse), so a spread over a captured snapshot would drop whichever
	 * landed first.
	 */
	const patchTab = (t: Tab, at: number, patch: Partial<TabState>): void => {
		if (generation.current[t] !== at) return;
		setTabs((current) => ({ ...current, [t]: { ...current[t], ...patch } }));
	};

	/** Abandon whatever this tab was doing, so no late write can land on it. */
	const supersede = (t: Tab): number => {
		generation.current[t] += 1;
		inFlight.current[t]?.abort();
		delete inFlight.current[t];
		return generation.current[t];
	};

	/** The one-file case, which renders the full preview rather than a ledger row. */
	const single = entries.length === 1 ? entries[0] : null;
	/** What Import would send: included, parsed, and carrying something to create. */
	const applicable = applicableEntries(entries);

	/**
	 * Put one tab back to empty and abandon its work: the preview's Dismiss and the dialog closing.
	 * **Not** a tab switch, which must leave a running fetch and the URL it is fetching in place.
	 */
	const resetTab = (t: Tab) => {
		const at = supersede(t);
		if (t === "url") setUrl("");
		if (t === "mcp") setMcpForm(emptyMcpForm());
		if (t === "paste") {
			setPasteText("");
			setPastedCommand(null);
		}
		patchTab(t, at, IDLE_TAB);
	};

	const handleClose = () => {
		if (applying) return;
		// Every tab, not just the visible one: another may be mid-download, and a reopened dialog
		// must not show work the user closed.
		TABS.forEach(resetTab);
		setReimports(null);
		close();
	};

	/**
	 * Bundle, detect and parse everything the user just handed over (issue #649 for the bundling,
	 * #666 for the "everything"). A multi-file OpenAPI spec is only itself once its `$ref`s are
	 * followed, and bundling is async while parsing is not, so it happens here rather than in
	 * `parseImport`, and each parser (and the engine) sees one self-contained document. Both
	 * intakes are passed and the batch layer uses whichever a ref needs: a file already in this
	 * batch, a sibling on disk through the gated IPC, or an absolute URL through the engine proxy.
	 */
	const runBatch = async (t: Tab, at: number, documents: BatchDocument[]): Promise<void> => {
		if (documents.length === 0) return;
		patchTab(t, at, { phase: "detecting", error: "" });
		const readSpecFile = window.electronAPI?.readSpecFile;
		const next = await detectBatch(
			documents,
			{ importEnvironments, importScripts },
			{
				maxBytes: specMaxBytes,
				// A `$ref` target is part of the document being bundled, so it has the bundle's
				// bound; stating it refuses where the bytes arrive, not after buffering whole a
				// file the engine would never store (issue #784).
				fetchUrl: async (target, options) =>
					(
						await apiService.importFetch(
							target,
							specMaxBytes,
							undefined,
							undefined,
							options
						)
					).content,
				...(readSpecFile
					? {
							readSibling: async (specPath, refPath) => {
								const { bytes } = await readSpecFile(specPath, refPath);
								// UTF-8, as `FileReader.readAsText` decoded the document beside it.
								// A non-UTF-8 sibling fails to parse and is reported as an
								// unresolved ref, which it is.
								return new TextDecoder("utf-8").decode(bytes);
							},
						}
					: {}),
			},
			(reported) => patchTab(t, at, { progress: reported })
		);
		// One failed document is the whole import failing, reported where it always is. Several is
		// a ledger, the failures rows beside the files that parsed: the only way a batch can report
		// a mixed outcome.
		const failedAlone = next.length === 1 && next[0].error;
		patchTab(t, at, {
			progress: null,
			entries: next,
			...(failedAlone
				? { error: next[0].error as string, phase: "error" as const }
				: { phase: "preview" as const }),
		});
	};

	/**
	 * Read and preview a file the OS handed Vayu (issue #1364): dropped on the Dock or taskbar
	 * icon, or a path on the command line. Takes the File tab's own path (`setTab`, `supersede`,
	 * `runBatch`), so this is a fourth *source* of a `BatchDocument`, not a fourth way to apply
	 * one.
	 */
	const importPendingFile = async (path: string): Promise<void> => {
		setTab("file");
		const at = supersede("file");
		patchTab("file", at, { phase: "detecting", progress: { stage: "reading" } });
		const readSpecFile = window.electronAPI?.readSpecFile;
		if (!readSpecFile) {
			// Outside Electron there is no gated channel to read the path
			// through, and no path here is safe to fetch as a URL instead.
			patchTab("file", at, {
				error: "Couldn't read this file outside the desktop app.",
				phase: "error",
			});
			return;
		}
		try {
			// `readSpecFile(specPath, refPath)` resolves `refPath` against `dirname(specPath)`, the
			// channel a spec's `$ref` reads a sibling through. Passing the file's own base name
			// reads that file and inherits the channel's extension allowlist and byte cap, instead
			// of opening a second door onto the filesystem.
			const name = fileBaseName(path);
			const { bytes, fileName } = await readSpecFile(path, name);
			// UTF-8, matching every other document this dialog reads.
			const text = new TextDecoder("utf-8").decode(bytes);
			await runBatch("file", at, [
				{ fileName, relativePath: fileName, specPath: path, text },
			]);
		} catch (e) {
			// Missing, over the byte cap or an extension `readSpecFile` refuses: its rejection
			// message already names which, in words a user can act on.
			patchTab("file", at, {
				error: e instanceof Error ? e.message : "Couldn't read this file.",
				phase: "error",
			});
		}
	};

	/**
	 * A path the OS handed Vayu while the dialog is up (issue #2275): the File tab's own pick,
	 * arriving from outside. An apply in flight refuses it: `importPendingFile` supersedes the File
	 * tab, and the apply's outcome write (which reports the failed files) is guarded by that
	 * generation. A preview or a read in progress is replaced, with a notice, because a ledger
	 * cannot take a document in after the fact (`detectBatch` is all-or-nothing over its
	 * documents). Neither leaves the path queued: a successful apply closes the dialog and `close`
	 * clears the store.
	 */
	const openOsPath = (path: string): void => {
		const name = fileBaseName(path);
		if (applying || reimports !== null) {
			showToast(`Couldn't open "${name}" while an import is running.`);
			return;
		}
		const { phase: filePhase } = tabs.file;
		if (filePhase === "preview" || filePhase === "detecting") {
			showToast(`Opened "${name}" in place of the file you were reviewing.`);
		}
		void importPendingFile(path);
	};

	// A path the OS handed Vayu (issue #1364), waiting for the dialog to open or arriving while it
	// is open (issue #2275). Keyed on the pending path as well as `isOpen`, like the pending-files
	// effect below, since an open dialog changes only the path. `takePendingPath` is the one read
	// and clears the path in the same step, so the re-run the clearing causes finds nothing and
	// cannot import a file twice.
	const pendingPath = useImportModalStore((s) => s.pendingPath);
	useEffect(() => {
		if (!isOpen || !pendingPath) return;
		const path = useImportModalStore.getState().takePendingPath();
		if (!path) return;
		// `importPendingFile` sets `tab` and this tab's phase synchronously as its first act: a
		// one-shot handoff of store state, the shape `McpSettingsPanel` and `VariableTableEditor`
		// suppress this rule for rather than restructure around.
		// eslint-disable-next-line react-hooks/set-state-in-effect -- see above
		openOsPath(path);
		// `openOsPath` closes over this render's tab state and is rebuilt every render, so naming
		// it would re-run the effect continuously; the take above has cleared the path, so every
		// later run finds nothing.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isOpen, pendingPath]);

	/**
	 * Re-parse when an option toggle changes, from the text already bundled: nothing is re-fetched
	 * and each file keeps the source it was read from, since a spec stored without its fetched URL
	 * has nothing to re-fetch from, and the toggles do not touch where the bytes came from.
	 *
	 * **Every tab holding a parse, not only the visible one** (issue #893): the options are
	 * dialog-wide and the entries per tab, so a hidden tab would keep a parse made under the old
	 * options, and importing it later would apply a setting the checkbox says is off. Per-tab
	 * options would make the same two checkboxes answer differently by tab.
	 */
	const redetect = (next: { importEnvironments: boolean; importScripts: boolean }) => {
		for (const t of TABS) {
			const state = tabs[t];
			if (state.phase !== "preview" || state.entries.length === 0) continue;
			// Supersede, not merely capture (issue #895). A re-parse is an engine round trip per
			// file and nothing disables the checkboxes meanwhile, so two toggles inside one round
			// trip would share a generation, both patches would pass `patchTab`'s check, and the
			// last to resolve would win. Bumping first drops the earlier toggle's late patch, so
			// the entries and the checkboxes describe one parse; they must, because `importScripts`
			// is baked in at parse time and ignored at apply (`orchestrator.ts`).
			//
			// Nothing is aborted: only a tab in `preview` reaches here, and the URL tab's fetch has
			// finished.
			const at = supersede(t);
			// Reported like the first parse, which it is again: one engine round trip per file, a
			// wait on a folder pick that a checkbox click must not make look instant.
			void reparseBatch(state.entries, next, (reported) =>
				patchTab(t, at, { progress: reported })
			).then((reparsed) => patchTab(t, at, { progress: null, entries: reparsed }));
		}
	};

	/**
	 * Read one picked file into a batch document. An unreadable file (a directory in a drop, a file
	 * moved between pick and read) becomes a document carrying the failure, not nothing: a picked
	 * file with no row is the silent discard this flow exists to end.
	 */
	const readDocument = (file: File): Promise<BatchDocument> =>
		new Promise((resolve) => {
			// The path at pick time, while a `File` exists to take it from: `getFilePath` reads it
			// off the object and reports it to main as picked, as the renderer cannot name a path
			// itself. Empty outside Electron and for a drag of remote content, which already means
			// "no remembered file". Main also resolves a sibling-file `$ref` against it (see
			// `readSpecFile`).
			const specPath = window.electronAPI?.getFilePath(file) ?? "";
			// `webkitRelativePath` is set by a folder pick and empty otherwise, so a flat drop is
			// keyed by file name, the same thing for files sharing a directory.
			const relativePath = file.webkitRelativePath || file.name;
			const reader = new FileReader();
			reader.onload = () =>
				resolve({
					fileName: file.name,
					relativePath,
					specPath,
					text: String(reader.result),
				});
			reader.onerror = () =>
				resolve({
					fileName: file.name,
					relativePath,
					specPath,
					text: "",
					readError: "Couldn't read the file",
				});
			reader.readAsText(file);
		});

	/**
	 * @param filterExtensions only for a folder pick, which hands over everything under it. A drop
	 *        or explicit selection is never filtered: the user named those files, and dropping one
	 *        for its extension is a silent discard.
	 */
	const handleFiles = async (files: File[], filterExtensions = false): Promise<void> => {
		const picked = filterExtensions ? files.filter((f) => isImportableFileName(f.name)) : files;
		// A pick supersedes whatever this tab was showing, so a late write from the
		// previous one cannot land on top of the new pick's.
		const at = supersede("file");
		if (picked.length === 0) {
			if (files.length > 0) {
				patchTab("file", at, {
					error: "No .json, .yaml, .yml or .jmx files in that folder.",
					phase: "error",
				});
			}
			return;
		}
		patchTab("file", at, { phase: "detecting", progress: { stage: "reading" } });
		await runBatch("file", at, await Promise.all(picked.map(readDocument)));
	};

	// Files dropped on the window outside this dialog (issue #2252). Keyed on the list as well as
	// `isOpen`: a drop on the open dialog's chrome changes only the list.
	const pendingFiles = useImportModalStore((s) => s.pendingFiles);
	useEffect(() => {
		if (!isOpen || pendingFiles.length === 0) return;
		const files = useImportModalStore.getState().takePendingFiles();
		// eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot store handoff, as the pending-path effect
		setTab("file");
		void handleFiles(files);
		// `handleFiles` is rebuilt every render; the take above empties the list,
		// so the re-run it causes finds nothing.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isOpen, pendingFiles]);

	// Fetching a URL and connecting to an MCP server are the sources a user can enter twice by hand,
	// so they need the guard. The
	// same phase disables the drop zone, the folder picker and the Paste button (a second drop
	// mid-read races the first as a second fetch does) and puts the progress panel on screen (issue
	// #882).
	const isBusy = phase === "detecting";

	/**
	 * Detect and preview a pasted document, on the Paste tab's own slice. A curl/wget command is a
	 * request, not a collection, so it never reaches the engine, which would answer "Unrecognized
	 * format" (#2250).
	 */
	const handlePaste = async (): Promise<void> => {
		if (isBusy) return;
		const at = supersede("paste");
		const command = importCommand(pasteText);
		setPastedCommand(command);
		if (command) {
			patchTab("paste", at, IDLE_TAB);
			return;
		}
		await runBatch("paste", at, [{ text: pasteText }]);
	};

	/** The creation flow the URL bar's paste feeds, and the same disclosure of what it dropped or renamed. */
	const openCommandAsRequest = (command: CommandImport): void => {
		newRequest(presetFromCommand(command.request));
		handleClose();
		for (const notice of pasteNotices(command)) showToast(notice);
	};

	const handleFetchUrl = async () => {
		if (isBusy) return;
		const at = supersede("url");
		const abort = new AbortController();
		inFlight.current.url = abort;
		patchTab("url", at, { phase: "detecting", error: "" });
		try {
			// No `maxBytes`: this box takes any format, and a Postman or Insomnia export is never
			// stored as a spec document, so `maxSpecDocumentBytes` would refuse an importable
			// export with a message naming a setting that does not apply. The engine's transport
			// ceiling backs the fetch instead (issue #784), and the bundler still refuses an
			// over-cap OpenAPI document once the format is known. The third argument asks the
			// engine to stream the download (issue #882); without it the route answers only once
			// the body is buffered, which freezes the dialog on an 8 MB spec. The fourth is this
			// tab's cancel (issue #893), without which the engine reads a 10 MB document on after
			// the dialog closed.
			const { content } = await apiService.importFetch(
				url,
				undefined,
				(received) => patchTab("url", at, { progress: { stage: "fetching", ...received } }),
				abort.signal
			);
			await runBatch("url", at, [{ text: content, sourceUrl: url }]);
		} catch (e) {
			// A cancel is no failure to report: only closing the dialog reaches it, and a banner
			// would wait for the next open, about a download the user stopped.
			if (abort.signal.aborted) return;
			patchTab("url", at, { progress: null, error: (e as Error).message, phase: "error" });
		} finally {
			if (inFlight.current.url === abort) delete inFlight.current.url;
		}
	};

	/**
	 * Ask the typed MCP server what it offers and preview the tree the engine builds from it. The
	 * answer is already parsed, so it becomes the tab's one entry directly (`mcpBatchEntry`): the
	 * preview, the notices and the apply are the other tabs' own from there. The collections an
	 * earlier import of the server built are looked up before the preview opens, so a duplicate is
	 * flagged before the user can import one; that lookup never fails the connect (#3842).
	 */
	const handleConnectMcp = async () => {
		if (isBusy || !canConnectMcp(mcpForm)) return;
		const at = supersede("mcp");
		const abort = new AbortController();
		inFlight.current.mcp = abort;
		patchTab("mcp", at, { phase: "detecting", error: "", progress: { stage: "connecting" } });
		const request = mcpImportRequest(mcpForm);
		try {
			const result = await apiService.importMcp(request, { signal: abort.signal });
			const existing = await existingMcpImports(request, abort.signal);
			patchTab("mcp", at, {
				progress: null,
				entries: [mcpBatchEntry(result, request.url, existing)],
				phase: "preview",
			});
		} catch (e) {
			// A cancel (`supersede`) moved the generation, so `patchTab` drops its AbortError.
			patchTab("mcp", at, { progress: null, error: (e as Error).message, phase: "error" });
		} finally {
			if (inFlight.current.mcp === abort) delete inFlight.current.mcp;
		}
	};

	/**
	 * What Import does: check for a document already bound, then apply (issue #680). The check runs
	 * here, not at detect time: it is a round trip per bound document, which a preview should not
	 * pay for, and Import is the last moment the answer can change anything (another window may
	 * have bound a collection since the preview was drawn).
	 *
	 * The lookup holds the button as the apply does: `POST /import/apply` is create-only, so a
	 * second press mid-lookup would import everything twice.
	 */
	const handleImport = async () => {
		if (applicable.length === 0 || applying) return;
		const candidates = specCandidates(applicable);
		if (candidates.length > 0) {
			setCheckingBindings(true);
			try {
				const matches = matchBoundSpecs(candidates, await readBoundSpecs(collections));
				if (matches.length > 0) {
					setReimports(matches);
					return;
				}
			} finally {
				setCheckingBindings(false);
			}
		}
		await runImport();
	};

	/**
	 * Apply the included files, **one transaction each** (issue #666). `POST /import/apply` is
	 * atomic within one call, so per-file keeps a refused seventh file from rolling back six good
	 * ones, lands each file as its own root collection (what N manual imports produce) and leaves
	 * the engine contract untouched; one combined payload would be all-or-nothing across unrelated
	 * files.
	 *
	 * Every attempted entry is unchecked afterwards, and an applied one cannot be checked again:
	 * the route is create-only with no idempotency key, so a resend is a second copy, not a retry.
	 * A failed file can be re-checked, the one honest retry, which is why its outcome stays on its
	 * row.
	 *
	 * Reached from Import and from the re-import fork's Import anyway, so it does not re-check the
	 * bindings: the user has just answered that.
	 */
	const runImport = async () => {
		if (applicable.length === 0) return;
		// The tab this apply belongs to, captured now: it writes outcomes onto its own rows, and
		// the user may be on another tab by the time the engine answers.
		const t = tab;
		const at = generation.current[t];
		const outcomes = new Map<string, BatchEntry["outcome"]>();
		const reports: ImportReport[] = [];
		// Across the whole batch: "exactly one environment" is a property of the import,
		// not of a file, so two files carrying one each is two.
		const createdEnvironmentIds: string[] = [];
		// The apply is one transaction per file.
		patchTab(t, at, { progress: { stage: "applying", done: 0, total: applicable.length } });
		for (const entry of applicable) {
			const result = entry.result as ImportResult;
			try {
				const applied = await importMutation.mutateAsync({
					result,
					opts: {
						importEnvironments,
						importScripts,
						// This file's own ticks: a batch applies one file at a time.
						selectedClientCertificates: entry.selectedCertificates ?? [],
					},
					// Only meaningful for a spec import; the mutation ignores it when
					// the parsed tree carries no spec document.
					...(entry.specPath && result.meta.fileName
						? { specFile: { path: entry.specPath, fileName: result.meta.fileName } }
						: {}),
				});
				reports.push(
					buildImportReport(
						result,
						Object.values(applied?.rootIds ?? {}),
						entry.selectedCertificates
					)
				);
				createdEnvironmentIds.push(...Object.values(applied?.environmentIds ?? {}));
				outcomes.set(entry.id, { ok: true, message: "Imported" });
			} catch (e) {
				// No rollback (#145): the engine write is atomic, so a validation failure persisted
				// nothing, but a failure after it (the id-map check, the globals write) leaves the
				// tree committed. Report it and keep the modal open; the mutation invalidates on
				// every outcome, so whatever landed already shows behind the dialog.
				// `importFailureMessage` maps the engine's temp id for the broken item back to the
				// name the preview shows (issue #173).
				outcomes.set(entry.id, { ok: false, message: importFailureMessage(e, result) });
			}
			patchTab(t, at, {
				progress: { stage: "applying", done: outcomes.size, total: applicable.length },
			});
		}
		const failures = [...outcomes.values()].filter((o) => o && !o.ok);
		if (failures.length === 0) {
			// Before the dialog closes: the engine's answer decides the toast, and the
			// dialog is still holding the progress view while it is asked.
			const environment = await activateImportedEnvironment(createdEnvironmentIds, {
				listEnvironments: () =>
					queryClient.fetchQuery({
						queryKey: queryKeys.environments.list(),
						queryFn: () => apiService.listEnvironments(),
						staleTime: 0,
					}),
				activate: (id) => setActiveEnvironment.mutateAsync({ id }),
			});
			handleClose();
			announceImport(reports, environment ?? undefined);
			return;
		}
		setTabs((current) => {
			if (generation.current[t] !== at) return current;
			return {
				...current,
				[t]: {
					...current[t],
					progress: null,
					entries: current[t].entries.map((entry) => {
						const outcome = outcomes.get(entry.id);
						return outcome ? { ...entry, outcome, included: false } : entry;
					}),
					// One file: the engine's own message, where it has always been.
					// Several: the count, because each row carries its own message.
					error:
						outcomes.size === 1
							? (failures[0]?.message ?? "Couldn't import this file")
							: `Couldn't import ${failures.length} of ${outcomes.size} files.`,
				},
			};
		});
	};

	/** Include or exclude one file of the batch. Nothing re-parses; only the apply set changes. */
	const toggleEntry = (id: string, included: boolean) => {
		const t = tab;
		setTabs((current) => ({
			...current,
			[t]: {
				...current[t],
				entries: current[t].entries.map((entry) =>
					entry.id === id ? { ...entry, included } : entry
				),
			},
		}));
	};

	/** Tick or untick one of a file's client-certificate candidates; only this file's selection moves. */
	const toggleCertificate = (id: string, index: number, ticked: boolean) => {
		const t = tab;
		setTabs((current) => ({
			...current,
			[t]: {
				...current[t],
				entries: current[t].entries.map((entry) =>
					entry.id === id
						? {
								...entry,
								selectedCertificates: withCertificateTicked(
									entry.selectedCertificates,
									index,
									ticked
								),
							}
						: entry
				),
			},
		}));
	};

	const toggleEnvironments = (v: boolean) => {
		setImportEnvironments(v);
		redetect({ importEnvironments: v, importScripts });
	};
	const toggleScripts = (v: boolean) => {
		setImportScripts(v);
		redetect({ importEnvironments, importScripts: v });
	};

	// Shared by all four tab panels; the inner conditionals already switch on
	// the active tab, and only the active panel is mounted.
	const panelBody = (
		<>
			{phase === "preview" ? (
				<>
					{single?.result ? (
						<PreviewView
							result={single.result}
							importEnvironments={importEnvironments}
							selectedCertificates={single.selectedCertificates}
							source={
								single.result.meta.format === IMPORT_MCP_FORMAT
									? entryLabel(single)
									: undefined
							}
							existingMcp={single.existingMcp}
							onDismiss={() => resetTab(tab)}
						/>
					) : (
						<BatchLedger
							entries={entries}
							onToggle={toggleEntry}
							onDismiss={() => resetTab(tab)}
						/>
					)}
					{/* An apply that failed leaves the list on screen - the per-file
					    outcomes are in it - so the message that would have replaced it
					    is stated here instead. */}
					<FieldError icon={AlertTriangle} className="mt-3">
						{error}
					</FieldError>
				</>
			) : (
				<>
					{tab === "file" && (
						/*
						 * A real <button>: focusable, in the tab order and operable by Enter or
						 * Space, the keyboard path to the hidden <input type="file"> beside
						 * drag-and-drop.
						 */
						/*
						 * The dashed edge is a drag-target affordance and wants prominence, but on
						 * this fill (`--muted`/`--accent`) `--border-strong` is the faintest option
						 * in dark (1.108, below `--border` at 1.157), as the fill sits between the
						 * two tokens in lightness. `surface-sunken`'s alpha-of-foreground rule is
						 * the strongest edge here in both themes (1.356 light / 1.343 dark), and
						 * its background equals `bg-accent`.
						 */
						<button
							type="button"
							disabled={isBusy}
							// `group`: the Upload glyph's `lift` fires on this dropzone's hover,
							// and the `Icon motion` block gates on a `[data-slot="button"]` or
							// `.group` ancestor, which a bare <button> is not.
							className="group w-full cursor-pointer rounded-lg border-2 border-dashed border-rule surface-sunken px-6 py-9 text-center disabled:cursor-default disabled:opacity-60"
							onClick={() => fileInputRef.current?.click()}
							onDragOver={(e) => e.preventDefault()}
							onDrop={(e) => {
								e.preventDefault();
								// A disabled <button> still receives drops, so the
								// guard has to be stated here too.
								if (isBusy) return;
								// Every dropped file, not `files[0]`, which would import the first
								// and silently drop the rest (issue #666).
								void handleFiles(Array.from(e.dataTransfer.files));
							}}
						>
							<Upload
								className="mx-auto h-6 w-6 text-muted-foreground"
								data-icon-motion={ICON_MOTION.lift}
							/>
							<span className="mt-2 block text-sm font-medium">
								Drop files here, or click to browse
							</span>
							<span className="block text-label text-muted-foreground">
								Format is detected per file - drop as many as you like
							</span>
							<span className="mt-4 flex flex-wrap justify-center gap-1.5">
								{FORMAT_BADGES.map((b) => (
									<span
										key={b}
										// Bare `bg-card` on purpose: the chip's edge faces the
										// sunken drop zone, so its `border-rule` must inherit the
										// zone's declaration, not declare a card rule of its own.
										className="rounded-md border border-rule bg-card px-2 py-0.5 text-micro font-semibold"
									>
										{b}
									</span>
								))}
							</span>
						</button>
					)}
					{tab === "file" && (
						<div className="mt-2 flex items-center justify-center gap-2 text-label text-muted-foreground">
							<span>Or bring in a whole directory of specs:</span>
							<Button
								variant="outline"
								size="sm"
								disabled={isBusy}
								onClick={() => folderInputRef.current?.click()}
							>
								<FolderOpen className="size-icon-sm" />
								Import folder
							</Button>
						</div>
					)}
					{/*
					 * Outside the button: nested, the programmatic .click() would bubble back to
					 * the button and re-enter this handler, and interactive content inside a button
					 * is invalid besides.
					 */}
					<input
						ref={fileInputRef}
						type="file"
						multiple
						className="hidden"
						onChange={(e) => void handleFiles(Array.from(e.target.files ?? []))}
					/>
					{/*
					 * The folder variant of the same input. `webkitdirectory` is not in React's
					 * attribute table, so it is spread in to reach the DOM. Only Chromium (so
					 * Electron) implements it; elsewhere the input degrades to an ordinary
					 * multi-file picker. Filtered to importable extensions: a directory pick hands
					 * over everything under it, and a ledger of PNGs would bury the specs.
					 */}
					<input
						ref={folderInputRef}
						type="file"
						multiple
						className="hidden"
						{...{ webkitdirectory: "", directory: "" }}
						onChange={(e) => void handleFiles(Array.from(e.target.files ?? []), true)}
					/>
					{tab === "url" && (
						<div className="flex gap-2">
							<Input
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								onKeyDown={(e) => {
									if (isCommitEnter(e) && url) handleFetchUrl();
								}}
								placeholder="https://petstore.swagger.io/v2/swagger.json"
								className="flex-1"
								disabled={isBusy}
							/>
							<Button onClick={handleFetchUrl} disabled={!url || isBusy}>
								<LabelSwap
									label={isBusy ? "Fetching…" : "Fetch"}
									states={["Fetch", "Fetching…"]}
								/>
							</Button>
						</div>
					)}
					{tab === "paste" && (
						<div>
							<Textarea
								value={pasteText}
								onChange={(e) => {
									setPasteText(e.target.value);
									setPastedCommand(null);
								}}
								placeholder="Paste collection JSON or YAML, or a cURL command"
								className="h-40 w-full font-mono text-xs"
							/>
							<Button
								onClick={() => void handlePaste()}
								disabled={!pasteText.trim() || isBusy}
								className="mt-2"
							>
								Detect and preview
							</Button>
							{pastedCommand && (
								<Callout
									severity="info"
									className="mt-3"
									action={
										<Button
											size="sm"
											onClick={() => openCommandAsRequest(pastedCommand)}
										>
											Open as new request
										</Button>
									}
								>
									This is a cURL command. Open it as a new request.
								</Callout>
							)}
						</div>
					)}
					{tab === "mcp" && (
						<ImportMcpForm
							form={mcpForm}
							onChange={setMcpForm}
							onConnect={() => void handleConnectMcp()}
							busy={isBusy}
						/>
					)}
					{/*
					 * Below the tab's controls, not replacing them: the URL being downloaded is the
					 * context a user waiting on 8 MB wants most, and the disabled Fetch button says
					 * a fetch is running. `progress` is null between the phase change and the first
					 * report, so the panel opens on a named busy bar rather than flashing nothing.
					 */}
					{isBusy && (
						<div className="mt-4">
							<ImportProgressView progress={progress ?? { stage: "reading" }} />
						</div>
					)}
					{phase === "error" && <FieldError className="mt-3">{error}</FieldError>}
				</>
			)}
		</>
	);

	return (
		/*
		 * Radix now owns the shell: Escape, the overlay click, focus and the
		 * shared presentation animation. Only the body below is ImportModal's.
		 */
		<Dialog open={isOpen} onOpenChange={(next) => !next && handleClose()}>
			<DialogContent
				// Overrides the default padded grid: this dialog draws its own header, tabs, body
				// and footer bands, each with its own divider.
				//
				// `bg-card surface-card` must stay a pair: `surface-card` sets the same background
				// from `@layer components`, so the primitive's `bg-background` utility would
				// outrank it, and tailwind-merge strips the primitive's only for `bg-card`. The
				// utility wins the cascade; the surface class contributes the `--rule` the dividers
				// resolve against.
				//
				// The shared `xl` width (576px), not a fixed `w-[560px]`, which a viewport narrower
				// than it would keep: `w-full` under a cap gives the same stable band without that
				// edge.
				//
				// The height guard is this dialog's own (issue #773): the primitive's
				// `max-h-[85vh]` + `DialogBody` suits one scrolling middle, and this panel has
				// bands with the scroll already on the one that needs it. `overflow-hidden` keeps
				// the scroll there, and 82vh leaves the dividers clear of the viewport edge.
				className="flex max-w-xl max-h-[82vh] flex-col gap-0 overflow-hidden border-border-strong bg-card surface-card p-0"
				// No prose description; without this Radix logs a missing
				// aria-describedby warning.
				aria-describedby={undefined}
			>
				<DialogHeader className="flex-row items-center justify-between space-y-0 border-b border-rule px-5 py-4">
					<DialogTitle>Import collection</DialogTitle>
				</DialogHeader>

				{/*
				 * The app's Tabs primitive, styled like the request builder's underline tabs; Radix
				 * brings the tabs keyboard model (one tab stop for the set, arrow keys between
				 * tabs).
				 *
				 * `size="sm"` (28px), not the `xs` default: the source tabs are this dialog's
				 * top-level navigation, the role the dashboard's root tabs play, while `xs` is
				 * sized for a strip nested in a chosen section (Collection Detail, the response
				 * viewer) and reads thinner than the header and footer bands here.
				 */}
				<Tabs
					value={tab}
					// Switching tab only shows the other tab (issue #893): a reset would clear the
					// display of work that goes on running.
					onValueChange={(v) => setTab(v as Tab)}
					className="flex min-h-0 flex-1 flex-col"
				>
					<TabsList variant="pane" size="sm" className="w-full">
						{TABS.map((t) => (
							<TabsTrigger key={t} value={t}>
								<TabLabel>{TAB_LABELS[t]}</TabLabel>
							</TabsTrigger>
						))}
					</TabsList>

					{/*
					 * One panel per tab, not one for the active value: Radix points each trigger's
					 * aria-controls at its own value's panel, so a single panel leaves two triggers
					 * referencing missing ids. Only the active panel mounts, so the shared body
					 * still renders once.
					 */}
					{TABS.map((t) => (
						<TabsContent
							key={t}
							value={t}
							/*
							 * `min-h` holds the tabs to one height, so the centred dialog does not
							 * resize on a switch. Sized to the tallest, the MCP server form: its
							 * panel measures 273px with its padding, against 230 for File, 184 for
							 * Paste and 58 for URL. Header rows the user adds grow it past that.
							 */
							className="mt-0 min-h-[273px] overflow-y-auto p-5"
						>
							{panelBody}
						</TabsContent>
					))}
				</Tabs>

				{phase === "preview" && (
					<div className="flex flex-col gap-3 border-t border-rule px-5 py-4">
						{/*
						 * In the footer rather than over the list: the per-file
						 * outcomes land on the ledger rows behind this, and covering
						 * them would hide the very thing the apply is producing.
						 */}
						{progress && <ImportProgressView progress={progress} />}
						<ImportClientCertificates
							entries={applicable}
							disabled={applying}
							onToggle={toggleCertificate}
						/>
						<div className="flex items-center justify-between gap-3">
							{/*
							 * One <label> each: a label's control is its *first* labelable
							 * descendant, so with both checkboxes in one label the second's words
							 * toggle the first, and the second has no label (its hit target the box
							 * alone). `size-target` (issue #1679, 24-28px) is the box's own floor;
							 * the labels fix which words each checkbox answers to, not its size.
							 */}
							{/*
							 * Not offered for an MCP server: its tree carries no environment, no global
							 * and no script, so both boxes would answer a question the source cannot
							 * ask. The values stay, for the tabs that do.
							 */}
							{tab !== "mcp" && (
								<div className="flex flex-col gap-1 text-label text-muted-foreground">
									<label className="flex w-fit items-center gap-1.5">
										<Checkbox
											checked={importEnvironments}
											disabled={applying}
											onChange={(e) => toggleEnvironments(e.target.checked)}
											className="size-target"
										/>
										Import environments &amp; variables
									</label>
									<label className="flex w-fit items-center gap-1.5">
										<Checkbox
											checked={importScripts}
											disabled={applying}
											onChange={(e) => toggleScripts(e.target.checked)}
											className="size-target"
										/>
										Import pre-request &amp; test scripts
									</label>
								</div>
							)}
							<div className="ml-auto flex gap-2">
								<DialogCancelButton
									onClick={handleClose}
									disabled={importMutation.isPending}
								/>
								<Button
									onClick={handleImport}
									disabled={applying || applicable.length === 0}
								>
									{applying
										? "Importing…"
										: importLabel(applicable.length, single?.existingMcp)}
								</Button>
							</div>
						</div>
					</div>
				)}

				{/* Mounted only while the fork is on screen, over this dialog: the
				    preview underneath is what Cancel goes back to, and what Import
				    anyway then imports. */}
				{reimports && (
					<SpecReimportDialog
						matches={reimports}
						onSync={(collectionId) => {
							setReimports(null);
							// Before the close, which resets this component's state:
							// the store call is what survives it.
							openCollectionSpecTab(collectionId);
							handleClose();
						}}
						onImportAnyway={() => {
							setReimports(null);
							void runImport();
						}}
						onCancel={() => setReimports(null)}
					/>
				)}
			</DialogContent>
			{/* Beside the content, not in it: the dialog closes before the picker is answered. */}
			<CollectionPicker {...pickerProps} />
		</Dialog>
	);
}

/**
 * The Import button's words. The count only appears for a batch: it is what the button is about to
 * do N times, and on one file it would just restate the preview. A server an earlier import already
 * built is imported anyway, as a second collection (#3842).
 */
function importLabel(count: number, existingMcp: ImportMcpDiffMatch[] | undefined): string {
	if (count > 1) return `Import ${count} files →`;
	return existingMcp && existingMcp.length > 0 ? "Import anyway →" : "Import →";
}

function PreviewView({
	result,
	importEnvironments,
	selectedCertificates,
	source,
	existingMcp,
	onDismiss,
}: {
	result: ImportResult;
	importEnvironments: boolean;
	selectedCertificates: readonly number[] | undefined;
	/** What the result was read from when `meta.fileName` does not say: the MCP server's URL. */
	source?: string;
	/** Earlier imports of this MCP server, compared with its listing now (#3842). */
	existingMcp?: ImportMcpDiffMatch[];
	onDismiss: () => void;
}) {
	const { meta, collections, environments, globals } = result;
	const globalCount = Object.keys(globals).length;
	const carriedOver = describeCarriedOver([result]);
	return (
		<div className="space-y-3">
			<Callout
				severity="info"
				positive
				title={meta.format}
				action={
					<TooltipIconButton
						className="-my-1"
						onClick={onDismiss}
						label="Dismiss"
						icon={<X className="size-icon-sm" />}
					/>
				}
			>
				{(meta.fileName ?? source) && (
					<span className="font-mono text-label text-muted-foreground">
						{meta.fileName ?? source}
					</span>
				)}
			</Callout>
			<div className="max-h-[190px] overflow-y-auto rounded-md border border-rule surface-sunken p-2">
				{collections.map((c, i) => (
					<TreeNode key={i} collection={c} />
				))}
				{/* For a Postman environment export, the environments are the entire import. */}
				{environments.map((e, i) => (
					<div
						key={i}
						className="flex items-center gap-1.5 py-0.5 pl-1 text-xs font-medium"
					>
						<Layers className="size-icon-sm text-primary" />
						{e.name}
						<span className="text-label font-normal text-muted-foreground">
							{varCountLabel(Object.keys(e.variables).length)}
						</span>
					</div>
				))}
				{/*
				 * Globals have no name of their own - they are a singleton scope, not a
				 * named environment - so the row names the destination rather than the file.
				 */}
				{globalCount > 0 && (
					<div className="flex items-center gap-1.5 py-0.5 pl-1 text-xs font-medium">
						<Globe className="size-icon-sm text-primary" />
						Globals
						<span className="text-label font-normal text-muted-foreground">
							{varCountLabel(globalCount)}
						</span>
					</div>
				)}
			</div>
			{/* The examples count is here rather than only in the tree because a
			    saved example lands inside a request with no row of its own (#481). */}
			<p className="text-label text-muted-foreground">{describeCounts(meta)}</p>
			{carriedOver && <p className="text-label text-muted-foreground">{carriedOver}</p>}
			{existingMcp && existingMcp.length > 0 && <McpReimportDiff matches={existingMcp} />}
			{collections.length === 0 && environments.length === 0 && globalCount === 0 && (
				<FieldError icon={AlertTriangle}>
					{importEnvironments
						? "Nothing to import from this file."
						: "No collections in this file. Enable Import environments & variables below to import its environments."}
				</FieldError>
			)}
			{globalCount > 0 && (
				<p className="text-label text-muted-foreground">
					Same-named globals will be overwritten.
				</p>
			)}
			<NoticeList
				notices={importResultNotices(
					result,
					unselectedCertificateCount(result, selectedCertificates)
				)}
			/>
			<ImportFileFolders results={[result]} />
		</div>
	);
}

/**
 * The batch ledger: one row per picked file (issue #666), whatever became of it: parsed,
 * unrecognised, unreadable, or inlined into another document as a `$ref` target. "There is a row
 * for it" is the property to hold; a row saying "Unrecognised format" is doing its job.
 *
 * Rows that cannot be imported start unchecked, and the checkbox is the only control: the counts,
 * the losses and the outcome are stated per file, in the single-file preview's words.
 */
function BatchLedger({
	entries,
	onToggle,
	onDismiss,
}: {
	entries: BatchEntry[];
	onToggle: (id: string, included: boolean) => void;
	onDismiss: () => void;
}) {
	const selected = applicableEntries(entries).length;
	return (
		<div className="space-y-3">
			<Callout
				severity="info"
				positive
				title={`${entries.length} files`}
				action={
					<TooltipIconButton
						className="-my-1"
						onClick={onDismiss}
						label="Dismiss"
						icon={<X className="size-icon-sm" />}
					/>
				}
			>
				<span className="text-label text-muted-foreground">
					{selected} selected for import
				</span>
			</Callout>
			<div className="max-h-[190px] overflow-y-auto rounded-md border border-rule surface-sunken p-2">
				{entries.map((entry) => (
					<BatchRow key={entry.id} entry={entry} onToggle={onToggle} />
				))}
			</div>
			{/* Once for the batch rather than per row: a folder several files
			    reference is one allow, and a row is a <label> that cannot hold
			    a button of its own. */}
			<ImportFileFolders
				results={applicableEntries(entries).flatMap((entry) =>
					entry.result ? [entry.result] : []
				)}
			/>
		</div>
	);
}

function BatchRow({
	entry,
	onToggle,
}: {
	entry: BatchEntry;
	onToggle: (id: string, included: boolean) => void;
}) {
	const { result, error, bundledInto, outcome } = entry;
	// Shared with the re-import dialog, so one file is called the same thing
	// wherever it is named.
	const name = entryLabel(entry);
	const notices = result
		? importResultNotices(
				result,
				unselectedCertificateCount(result, entry.selectedCertificates)
			)
		: [];
	return (
		<label className="flex items-start gap-2 py-1 pl-1 text-xs">
			<Checkbox
				className="mt-1 size-icon"
				checked={entry.included}
				// An applied file is the one thing that must not be re-sent:
				// `POST /import/apply` is create-only and carries no idempotency key,
				// so a second send is a second copy of the tree, not a retry.
				disabled={!result || outcome?.ok === true}
				onChange={(e) => onToggle(entry.id, e.target.checked)}
				aria-label={name}
			/>
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline gap-1.5">
					<span className="truncate font-medium">{name}</span>
					{result && (
						<span className="shrink-0 text-micro font-semibold text-muted-foreground">
							{result.meta.format}
						</span>
					)}
				</span>
				{result && (
					<span className="block text-label text-muted-foreground">
						{describeCounts(result.meta)}
					</span>
				)}
				{bundledInto && (
					<span className="flex items-center gap-1.5 text-label text-muted-foreground">
						<Link2 className="size-icon-sm shrink-0" />
						Referenced by {bundledInto} - imported as part of it
					</span>
				)}
				<FieldError as="span" icon={FileWarning}>
					{error}
				</FieldError>
				<NoticeList notices={notices} as="span" />
				{outcome && (
					<span
						className={`flex items-center gap-1.5 text-label ${
							outcome.ok ? "text-status-success-text" : "text-destructive-text"
						}`}
					>
						{outcome.ok ? (
							<CheckCircle2 className="size-icon-sm shrink-0" />
						) : (
							<FileWarning className="size-icon-sm shrink-0" />
						)}
						{outcome.message}
					</span>
				)}
			</span>
		</label>
	);
}

function varCountLabel(n: number): string {
	return `${n} ${pluralize(n, "variable")}`;
}

/**
 * One collection of the preview and everything beneath it, sub-folders and requests in the order
 * the sidebar lists them (issue #2535): the order a Postman collection, a JMeter plan, an Insomnia
 * export or a Vayu-written OpenAPI document states, and folders first for any other format.
 */
function TreeNode({ collection }: { collection: CollectionDraft }) {
	return (
		<div className="pl-1">
			<div className="flex items-center gap-1.5 py-0.5 text-xs font-medium">
				<Folder className="size-icon-sm text-primary" />
				{collection.name}
			</div>
			<div className="pl-5">
				{draftSiblings(collection).map((sibling, i) =>
					sibling.kind === "folder" ? (
						<TreeNode key={i} collection={sibling.draft} />
					) : (
						<div
							key={i}
							className="flex items-center gap-2 py-0.5 text-label text-muted-foreground"
						>
							<MethodBadge
								method={sibling.draft.method}
								variant="text"
								className="w-10"
							/>
							<span>{sibling.draft.name}</span>
						</div>
					)
				)}
			</div>
		</div>
	);
}

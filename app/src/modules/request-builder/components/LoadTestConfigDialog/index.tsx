/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Load test configuration: the dialog shell, the mode row and the Start handler. Profile fields,
 * disclosures, data file, notices, saved memo and payload are the files beside it.
 */

import { useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { LoadTestConfig, OAuth2Config, ResolvedElement } from "@/types";
import { requestReference, type ThresholdOwner } from "@/lib/agent-reference";
import { appSetting } from "@/modules/settings/main/app-settings";
import { getAppPanel } from "@/modules/settings/main/app-panels";
import OAuth2LoadTestGuard from "../OAuth2LoadTestGuard";
import { OAUTH2_GATE_REASON } from "../oauth2-load-test-coverage";
import { OAuth2DeferredNote } from "./OAuth2DeferredNote";
import { resolveLoadTestLimits } from "@/constants/load-test";
import { useClientSettingsStore } from "@/stores";
import {
	Button,
	Input,
	Label,
	Dialog,
	DialogContent,
	DialogBody,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	DialogCancelButton,
	DisabledHint,
} from "@/components/ui";
import type { ColumnAuditRequest } from "@/hooks/useColumnAudit";
import { useRequestDefaultsQuery } from "@/queries";
import { useSavedLoadTestConfig, type LoadTestProfile } from "./useSavedLoadTestConfig";
import { buildNotices } from "./notices";
import {
	budgetsChanged,
	budgetsToRemember,
	carriedForRun,
	carriedThresholdKeys,
	clearCarried,
	describeCarried,
	stillCarried,
	withoutUnsentSeed,
} from "./carried-budgets";
import { RecordingSection } from "./RecordingSection";
import { BudgetsSection } from "./BudgetsSection";
import { MonitoringSection } from "./MonitoringSection";
import { SCRIPTS_DEFAULT, buildLoadTestConfig, type ScriptsOverride } from "./buildLoadTestConfig";
import { DataFileSection } from "./DataFileSection";
import { useLoadTestDataFile } from "./useLoadTestDataFile";
import { ScriptsOverrideToggle } from "./ScriptsOverrideToggle";
import { ProfileFields } from "./ProfileFields";
import { usesDuration } from "./profile";
import { ProfilePicker } from "./ProfilePicker";
import { summarise, totalRequests } from "./summary";
import { classifyTarget } from "./target";
import { TargetLine } from "./TargetLine";
import { describeDefaultHeaderDifference } from "./default-headers";
import { firstBlockingError, validateLoadTestDraft } from "./validation";
import { useMonitorSettings } from "@/hooks/useMonitorSettings";

export interface LoadTestConfigDialogProps {
	onClose: () => void;
	onStart: (config: LoadTestConfig) => void;
	isStarting: boolean;
	/**
	 * An enabled, non-blank pre-request script not marked inline (`hasUnmarkedPreScript`): the
	 * engine skips it unless Scripts is All inline.
	 */
	hasPreRequestScript: boolean;
	/**
	 * An enabled, non-blank pre-request script marked inline (`hasInlinePreScript`): it runs at As
	 * marked; only All deferred skips it.
	 */
	hasInlinePreScript: boolean;
	/**
	 * A post-request script (own or inherited) not marked inline, so replayed after the run on a
	 * sample of responses (`hasReplayedPostScript`).
	 */
	hasPostRequestScript: boolean;
	/** Variable-resolved OAuth 2.0 config, when the effective auth is oauth2. */
	oauth2Config?: OAuth2Config;
	/**
	 * Names in that OAuth 2.0 config a pre-request script may change, from the engine's
	 * `deferredVariables` (#2742). A load run fetches its token before any script, so the dialog
	 * says those changes do not apply. Memoise it.
	 */
	oauth2DeferredNames?: readonly string[];
	/**
	 * The request's `stream` setting is on (#576). It gates the two cap fields rather than being
	 * set here: streaming belongs to the request (its Settings tab), only *how much of each stream
	 * is measured* to the run, and caps on a non-streaming request bound nothing.
	 */
	isStreamingRequest: boolean;
	/**
	 * The request's collection, for the data file's contract (#993, #2050). Only the contract is
	 * resolved from it (the nearest declaring ancestor, `resolveDataContract`, as everywhere), so a
	 * file missing a declared column is said here, not at the first bind, and a picked file
	 * declares for that ancestor. Undefined with no collection: no contract, so a pick declares
	 * nothing and stays a plain run input.
	 */
	collectionId?: string;
	/**
	 * The request as the editor holds it (the draft, not the stored row), to audit which
	 * `{{data.*}}` columns it references that a picked file lacks (#2050). Memoise it: the audit
	 * depends on it.
	 */
	request?: ColumnAuditRequest;
	/**
	 * The saved request, for each budget's "Copy for agent": the stored row's id and name, not the
	 * draft's, since the agent's tools do not know an unsaved rename. Absent with no saved row.
	 */
	referenceOwner?: ThresholdOwner;
	/**
	 * Collection names above the saved request, root first, so the target line's "Copy request for
	 * agent" says where it lives as the sidebar's copy does. Read only when `referenceOwner` is
	 * set.
	 */
	collectionPath?: readonly string[];
	/**
	 * Enabled elements in the run's chain that only a scenario runs (`scenarioOnlyElements`,
	 * #3050), each with the origin naming where to remove it. Any one blocks Start. Memoise it.
	 */
	scenarioOnlyElements?: readonly ResolvedElement[];
	/**
	 * Closes this dialog and opens the collection-run flow, the way out of `scenarioOnlyElements`.
	 * Absent when the collection could not be resolved.
	 */
	onRunCollection?: () => void;
	/** The request's HTTP method, for the target line. */
	method?: string;
	/**
	 * The variable-resolved URL, as the run sends it (#2117). It names the target and decides the
	 * off-network advisory; absent, the dialog says nothing about the target.
	 */
	url?: string;
}

const NO_NAMES: readonly string[] = [];
const NO_ELEMENTS: readonly ResolvedElement[] = [];

/** Both names are the Settings screen's own, so a rename there reaches this footer. */
const ALLOWLIST = appSetting("mcp-allowlist");
const ALLOWLIST_LABEL = ALLOWLIST.label;
const AGENT_PANEL_LABEL = getAppPanel(ALLOWLIST.panel)?.label;

/** Why Start is disabled, or false when it is not. */
function startDisabledReason({
	isStarting,
	blockingError,
	elementsError,
	oauthGated,
}: {
	isStarting: boolean;
	blockingError: string | null;
	elementsError: string | null;
	oauthGated: boolean;
}): string | false {
	if (isStarting) return "Starting the run…";
	if (blockingError === null) return oauthGated && OAUTH2_GATE_REASON;
	// No field fixes it: the notice names the elements and the way out.
	if (blockingError === elementsError) {
		return "Disable or remove the elements named above, or run the collection instead.";
	}

	return "Fix the highlighted setting above.";
}

export default function LoadTestConfigDialog({
	onClose,
	onStart,
	isStarting,
	hasPreRequestScript,
	hasInlinePreScript,
	hasPostRequestScript,
	oauth2Config,
	oauth2DeferredNames = NO_NAMES,
	isStreamingRequest,
	collectionId,
	request,
	referenceOwner,
	collectionPath = [],
	scenarioOnlyElements = NO_ELEMENTS,
	onRunCollection,
	method,
	url,
}: LoadTestConfigDialogProps) {
	// The ceilings are a user setting (Settings -> Load testing), so every range is resolved.
	const ceilings = useClientSettingsStore((s) => s.loadTestCeilings);
	const limits = useMemo(() => resolveLoadTestLimits(ceilings), [ceilings]);
	// The p99 budget and Capacity Discovery's latency budget start from the user's capacity SLO
	// (Settings -> `sloThresholdMs`).
	const sloThresholdMs = useClientSettingsStore((s) => s.sloThresholdMs);
	/**
	 * The cadence and metric cap are engine settings (`monitorIntervalMs` / `monitorMaxSeries`),
	 * and the dialog seeds and bounds itself from them: it always sends an explicit interval, so
	 * otherwise the cadence setting would never apply here, and a raised cap would still be refused
	 * locally.
	 */
	const monitorSettings = useMonitorSettings();
	const { initial, save } = useSavedLoadTestConfig(limits, {
		sloThresholdMs,
		monitorIntervalMs: monitorSettings.defaultIntervalMs,
	});

	const runLabelRef = useRef<HTMLInputElement>(null);
	const [profile, setProfile] = useState(initial.profile);
	const updateProfile = (patch: Partial<LoadTestProfile>) =>
		setProfile((prev) => ({ ...prev, ...patch }));
	const [maxInFlight, setMaxInFlight] = useState(initial.maxInFlight);
	const [sampleRate, setSampleRate] = useState(initial.sampleRate);
	const [slowThreshold, setSlowThreshold] = useState(initial.slowThreshold);
	const [saveTimingBreakdown, setSaveTimingBreakdown] = useState(initial.saveTimingBreakdown);
	const [retryAfterBackoff, setRetryAfterBackoff] = useState(initial.retryAfterBackoff);
	const [retryAfterMaxMs, setRetryAfterMaxMs] = useState(initial.retryAfterMaxMs);
	const [budgets, setBudgets] = useState(initial.budgets);
	const [customBudgets, setCustomBudgets] = useState(initial.customBudgets);
	const [failRun, setFailRun] = useState(initial.failRun);
	const [monitor, setMonitor] = useState(initial.monitor);
	const [comment, setComment] = useState(""); // Per-run: never restored.
	const [oauthGated, setOauthGated] = useState(false);
	const [scriptsOverride, setScriptsOverride] = useState<ScriptsOverride>(SCRIPTS_DEFAULT);

	const dataFile = useLoadTestDataFile(collectionId, request);

	/*
	 * The Headers tab shows the design answer, read just before this dialog opens (#1338).
	 * `negotiateCompression` and `loadNegotiateCompression` are separate keys, so the scopes can
	 * disagree on `Accept-Encoding`; reading both lets the notice say so instead of silently
	 * sending something the tab did not show.
	 */
	const { data: designDefaults } = useRequestDefaultsQuery("design");
	const { data: loadDefaults } = useRequestDefaultsQuery("load");
	const defaultHeaderDifference = describeDefaultHeaderDifference(designDefaults, loadDefaults);

	const errors = validateLoadTestDraft({
		profile,
		budgets,
		customBudgets,
		monitor,
		maxSeries: monitorSettings.maxSeries,
		scenarioOnly: scenarioOnlyElements,
		isStreamingRequest,
		limits,
		slowThreshold,
		maxInFlight,
		retryAfterBackoff,
		retryAfterMaxMs,
	});
	// A refused file leaves no rows, so the run would send its `{{data.*}}` tokens as written, the
	// failure the namespace exists to prevent. The picker prints why; this stops Start.
	const blockingError = firstBlockingError(errors) ?? dataFile.error;

	// Classified once: the target line and the advisory read the same answer.
	const target = useMemo(() => (url === undefined ? null : classifyTarget(url)), [url]);
	const remoteTarget =
		target?.kind === "host" && !target.isLocal
			? {
					host: target.host,
					requestCount: totalRequests(profile),
					countWithheld: blockingError !== null,
				}
			: null;

	// The carried fields the user has not edited since the dialog opened.
	const carried = stillCarried(
		carriedForRun(initial.carried, isStreamingRequest),
		{ budgets: initial.budgets, customBudgets: initial.customBudgets },
		{ budgets, customBudgets }
	);
	// The notice and Clear speak only for what this run sends: in Capacity or on a stream the
	// Settings p99 seed is dormant, so neither names it.
	const judgedCarried = withoutUnsentSeed(carried, profile.mode, isStreamingRequest);
	const carriedSummary = describeCarried(
		judgedCarried,
		budgets,
		customBudgets,
		initial.budgetsFrom
	);

	const clearCarriedBudgets = () => {
		const cleared = clearCarried(judgedCarried, budgets, customBudgets);
		setBudgets(cleared.budgets);
		setCustomBudgets(cleared.customBudgets);
	};

	const notices = buildNotices({
		...errors,
		hasPreRequestScript,
		hasInlinePreScript,
		hasPostRequestScript,
		scriptsOverride,
		defaultHeaderDifference,
		remoteTarget,
		carriedBudgets: carriedSummary
			? { summary: carriedSummary, onClear: clearCarriedBudgets }
			: null,
		onRunCollection,
	});

	/**
	 * The memo's budgets name this request only if this Start changed them; an untouched carry
	 * keeps its setter.
	 */
	const budgetsOriginToSave = () => {
		const changed = budgetsChanged(
			{ budgets: initial.budgets, customBudgets: initial.customBudgets },
			{ budgets, customBudgets }
		);
		if (!changed) return initial.budgetsFrom;
		return referenceOwner?.type === "request"
			? { requestName: referenceOwner.request.name }
			: undefined;
	};

	const handleStart = () => {
		if (blockingError) return;

		const maxInFlightValue = maxInFlight.trim() !== "" ? Number(maxInFlight) : null;

		save({
			...profile,
			maxInFlight: maxInFlightValue,
			sampleRate,
			slowThreshold,
			saveTimingBreakdown,
			retryAfterBackoff,
			retryAfterMaxMs,
			budgets: budgetsToRemember(budgets, profile.mode, isStreamingRequest, carried.fixed),
			budgetsFrom: budgetsOriginToSave(),
			customBudgets,
			failRun,
			monitor,
		});

		onStart(
			buildLoadTestConfig({
				profile,
				sampleRate,
				slowThreshold,
				saveTimingBreakdown,
				retryAfterBackoff,
				retryAfterMaxMs,
				maxInFlight: maxInFlightValue,
				budgets,
				customBudgets,
				failRun,
				monitor,
				comment,
				carriedBudgets: carriedThresholdKeys(carried, customBudgets),
				budgetSources: carried.fixed,
				scriptsOverride,
				dataFile: dataFile.file,
				isStreamingRequest,
			})
		);
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				className="max-w-xl lg:max-w-4xl"
				// Radix would focus the first tabbable, TargetLine's Copy for agent
				// button, whose tooltip opens on focus (#3608).
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					runLabelRef.current?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>Run a load test</DialogTitle>
					<DialogDescription>
						{target && url !== undefined ? (
							<TargetLine
								method={method}
								url={url}
								target={target}
								agentReference={
									referenceOwner?.type === "request"
										? requestReference(referenceOwner.request, collectionPath)
										: undefined
								}
							/>
						) : (
							"Pick a profile, set its parameters, then start the run."
						)}
					</DialogDescription>
					<p className="text-label leading-relaxed text-muted-foreground">
						A request times out after its own Request timeout (Settings tab) or, without
						one, Default request timeout (Settings › Network &amp; connectivity). To
						pace virtual users, add a Think time element on the request&apos;s Elements
						tab.
					</p>
				</DialogHeader>

				{/*
				 * Pinned between header and body, not in the scroller: a blocking notice explains
				 * why Start is disabled, and in a two-pane body it would scroll away with its
				 * column. Capped so a stack cannot take the fields' height. `-mx-1 px-1 py-px` is
				 * DialogBody's clearance (#1627), so a focused notice button's ring is not clipped.
				 */}
				{notices.length > 0 && (
					<div
						data-slot="load-test-notices"
						className="-mx-1 max-h-[30vh] shrink-0 space-y-3 overflow-y-auto px-1 py-px"
					>
						{notices.map((n) => (
							<div key={n.key}>{n.node}</div>
						))}
					</div>
				)}

				<DialogBody className="space-y-4">
					{/* Two panes from `lg`: what the run does on the left, what it records and checks on the right. */}
					<div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
						<div className="min-w-0 space-y-4">
							{/*
							 * First field, not last under "Recording & limits": naming a run comes
							 * before picking its profile, and a comment written after the run
							 * started is about a run already forgotten.
							 */}
							<div className="space-y-1.5">
								<Label htmlFor="lt-comment" className="text-xs">
									Run label
									<span className="ml-1 font-normal text-muted-foreground">
										(optional)
									</span>
								</Label>
								<Input
									id="lt-comment"
									ref={runLabelRef}
									type="text"
									value={comment}
									onChange={(e) => setComment(e.target.value)}
									placeholder="Checkout after the cache change"
									aria-describedby="lt-comment-hint"
									className="text-sm"
								/>
								<p
									id="lt-comment-hint"
									className="text-label leading-relaxed text-muted-foreground"
								>
									Shown with this run in History.
								</p>
							</div>

							<div className="space-y-1.5">
								<span className="block text-xs font-medium leading-none">
									Load profile
								</span>
								<ProfilePicker
									value={profile.mode}
									onChange={(next) => updateProfile({ mode: next })}
									disabled={isStarting}
								/>
							</div>

							<ProfileFields
								profile={profile}
								onChange={updateProfile}
								limits={limits}
								isStreamingRequest={isStreamingRequest}
							/>

							<p className="rounded-md border border-border bg-panel px-3 py-2 text-label leading-relaxed text-muted-foreground">
								{summarise(profile, blockingError !== null)}
							</p>
						</div>

						<div className="min-w-0 space-y-4">
							<ScriptsOverrideToggle
								value={scriptsOverride}
								onChange={setScriptsOverride}
							/>

							<DataFileSection dataFile={dataFile} disabled={isStarting} />

							<RecordingSection
								mode={profile.mode}
								limits={limits}
								sampleRate={sampleRate}
								onSampleRateChange={setSampleRate}
								slowThreshold={slowThreshold}
								onSlowThresholdChange={setSlowThreshold}
								maxInFlight={maxInFlight}
								onMaxInFlightChange={setMaxInFlight}
								saveTimingBreakdown={saveTimingBreakdown}
								onSaveTimingBreakdownChange={setSaveTimingBreakdown}
								retryAfterBackoff={retryAfterBackoff}
								onRetryAfterBackoffChange={setRetryAfterBackoff}
								retryAfterMaxMs={retryAfterMaxMs}
								onRetryAfterMaxMsChange={setRetryAfterMaxMs}
							/>

							<BudgetsSection
								budgets={budgets}
								onBudgetsChange={setBudgets}
								customBudgets={customBudgets}
								onCustomBudgetsChange={setCustomBudgets}
								failRun={failRun}
								onFailRunChange={setFailRun}
								disabled={isStarting}
								referenceOwner={referenceOwner}
								mode={profile.mode}
								budgetSources={carried.fixed}
								isStreamingRequest={isStreamingRequest}
							/>

							<MonitoringSection
								monitor={monitor}
								onMonitorChange={setMonitor}
								maxSeries={monitorSettings.maxSeries}
							/>
						</div>
					</div>

					{/* Full width under both panes: it gates Start, so it reads just above it. */}
					{oauth2Config && (
						<>
							<OAuth2DeferredNote names={oauth2DeferredNames} />
							<OAuth2LoadTestGuard
								config={oauth2Config}
								durationSeconds={
									usesDuration(profile.mode) ? profile.duration : null
								}
								scriptMayChangeSettings={oauth2DeferredNames.length > 0}
								collectionId={collectionId}
								onGateChange={setOauthGated}
							/>
						</>
					)}

					<p className="text-label leading-relaxed text-muted-foreground">
						An agent can start this run too with{" "}
						<span className="font-mono">start_load_run</span> (Settings ›{" "}
						{AGENT_PANEL_LABEL}). Its host must be on the {ALLOWLIST_LABEL}.
					</p>
				</DialogBody>

				<DialogFooter>
					<DialogCancelButton onClick={onClose} disabled={isStarting} />
					{/*
					 * The OAuth2 gate gets a hint: its guard says what is wrong but collapses, and
					 * Start then reads as broken. `blockingError` is already shown beside its
					 * field, so this only points at it.
					 */}
					<DisabledHint
						reason={startDisabledReason({
							isStarting,
							blockingError,
							elementsError: errors.scenarioOnlyError,
							oauthGated,
						})}
					>
						<Button
							onClick={handleStart}
							disabled={isStarting || blockingError !== null || oauthGated}
						>
							{isStarting ? (
								<>
									<Loader2 className="size-icon animate-spin" />
									Starting…
								</>
							) : (
								"Start"
							)}
						</Button>
					</DisabledHint>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

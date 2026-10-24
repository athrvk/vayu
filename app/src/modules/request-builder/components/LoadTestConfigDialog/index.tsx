/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Load test configuration: the dialog shell, the mode row and the Start
 * handler. Each profile's fields, the three disclosures, the data file, the
 * notices, the saved memo and the payload are the files beside it.
 */

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { LoadTestConfig, OAuth2Config } from "@/types";
import { requestReference, type ThresholdOwner } from "@/lib/agent-reference";
import { appSetting } from "@/modules/settings/main/app-settings";
import { getAppPanel } from "@/modules/settings/main/app-panels";
import OAuth2LoadTestGuard from "../OAuth2LoadTestGuard";
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
	carriedThresholdKeys,
	clearCarried,
	describeCarried,
	stillCarried,
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
	/** True when the pending request has a non-empty preRequestScript. */
	hasPreRequestScript: boolean;
	/**
	 * True when a post-request script (the request's own or an inherited
	 * collection one) would be replayed after the run on a sample of
	 * responses, i.e. it is not marked inline (`hasReplayedPostScript`).
	 */
	hasPostRequestScript: boolean;
	/** Variable-resolved OAuth 2.0 config, when the effective auth is oauth2. */
	oauth2Config?: OAuth2Config;
	/**
	 * The names in that OAuth 2.0 config that a pre-request script may change,
	 * from the engine's `deferredVariables` (#2742). A load run fetches its token
	 * before any script, so the dialog says the script's changes do not apply.
	 * Memoise it.
	 */
	oauth2DeferredNames?: readonly string[];
	/**
	 * True when the pending request has its `stream` setting on (issue #576).
	 *
	 * It gates the two cap fields rather than being set here: whether a request
	 * streams belongs to the request (its Settings tab), and only *how much of
	 * each stream this run measures* belongs to the run. Showing the caps for a
	 * request that does not stream would offer bounds on something that is not
	 * happening.
	 */
	isStreamingRequest: boolean;
	/**
	 * The collection the request being load-tested belongs to, for the data
	 * file's contract (issues #993, #2050).
	 *
	 * Only the *contract* is resolved from it - the nearest declaring ancestor,
	 * the rule every other surface applies (`resolveDataContract`) - so a file
	 * missing a column the collection declares is said here rather than at the
	 * first bind, and a picked file declares for that ancestor. Undefined for a
	 * request that belongs to no collection, which has no contract: a pick there
	 * declares nothing and stays a plain run input.
	 */
	collectionId?: string;
	/**
	 * The request being load-tested, as the editor holds it - the draft, not the
	 * stored row - for the audit of which `{{data.*}}` columns it references
	 * that a picked file lacks (issue #2050). Memoise it: it is a dependency of
	 * the audit.
	 */
	request?: ColumnAuditRequest;
	/**
	 * The saved request, for each budget's "Copy for agent". The stored row's id
	 * and name, not the draft's: an unsaved rename is not a name the agent's
	 * tools know. Absent for a request with no saved row.
	 */
	referenceOwner?: ThresholdOwner;
	/**
	 * The collection names above the saved request, root first, so the target
	 * line's "Copy request for agent" says where the request lives the way the
	 * sidebar's copy does. Read only when `referenceOwner` is a request.
	 */
	collectionPath?: readonly string[];
	/** The request's HTTP method, for the target line. */
	method?: string;
	/**
	 * The request's URL with its variables resolved, as the run will send it
	 * (#2117). It names the target and decides the off-network advisory; absent,
	 * the dialog says nothing about where the run is aimed.
	 */
	url?: string;
}

const NO_NAMES: readonly string[] = [];

/** Both names are the Settings screen's own, so a rename there reaches this footer. */
const ALLOWLIST = appSetting("mcp-allowlist");
const ALLOWLIST_LABEL = ALLOWLIST.label;
const AGENT_PANEL_LABEL = getAppPanel(ALLOWLIST.panel)?.label;

export default function LoadTestConfigDialog({
	onClose,
	onStart,
	isStarting,
	hasPreRequestScript,
	hasPostRequestScript,
	oauth2Config,
	oauth2DeferredNames = NO_NAMES,
	isStreamingRequest,
	collectionId,
	request,
	referenceOwner,
	collectionPath = [],
	method,
	url,
}: LoadTestConfigDialogProps) {
	/**
	 * The ceilings are a user setting (Settings -> Load testing), so every range
	 * below is resolved rather than read off the constant.
	 */
	const ceilings = useClientSettingsStore((s) => s.loadTestCeilings);
	const limits = useMemo(() => resolveLoadTestLimits(ceilings), [ceilings]);
	/**
	 * The p99 budget and Capacity Discovery's latency budget both start from the
	 * capacity SLO the user already set (Settings -> `sloThresholdMs`), which
	 * until now only annotated a chart.
	 */
	const sloThresholdMs = useClientSettingsStore((s) => s.sloThresholdMs);
	/**
	 * Server monitoring. The cadence and the metric cap are engine settings
	 * (`monitorIntervalMs` / `monitorMaxSeries`), so the dialog seeds and bounds
	 * itself from them rather than from its own numbers - otherwise the cadence
	 * setting would never apply to a run started here (this dialog always sends
	 * an explicit interval) and a raised cap would still be refused locally.
	 */
	const monitorSettings = useMonitorSettings();
	const { initial, save } = useSavedLoadTestConfig(limits, {
		sloThresholdMs,
		monitorIntervalMs: monitorSettings.defaultIntervalMs,
	});

	const [profile, setProfile] = useState(initial.profile);
	const updateProfile = (patch: Partial<LoadTestProfile>) =>
		setProfile((prev) => ({ ...prev, ...patch }));
	const [maxInFlight, setMaxInFlight] = useState(initial.maxInFlight);
	const [sampleRate, setSampleRate] = useState(initial.sampleRate);
	const [slowThreshold, setSlowThreshold] = useState(initial.slowThreshold);
	const [saveTimingBreakdown, setSaveTimingBreakdown] = useState(initial.saveTimingBreakdown);
	const [budgets, setBudgets] = useState(initial.budgets);
	const [customBudgets, setCustomBudgets] = useState(initial.customBudgets);
	const [failRun, setFailRun] = useState(initial.failRun);
	const [monitor, setMonitor] = useState(initial.monitor);
	const [comment, setComment] = useState(""); // Per-run: never restored.
	const [oauthGated, setOauthGated] = useState(false);
	const [scriptsOverride, setScriptsOverride] = useState<ScriptsOverride>(SCRIPTS_DEFAULT);

	const dataFile = useLoadTestDataFile(collectionId, request);

	/*
	 * The Headers tab renders the design answer, and it is the tab a user reads
	 * right before opening this dialog (issue #1338). `negotiateCompression`
	 * and `loadNegotiateCompression` are two config keys, so the two scopes can
	 * disagree on `Accept-Encoding` - reading both here is what lets the notice
	 * below say so, rather than the dialog silently starting a run that sends
	 * something different from what the tab just showed.
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
	});
	// A file the parser refused leaves no rows behind, so starting the run would
	// send the request with its `{{data.*}}` tokens written as they stand - the
	// failure the whole namespace exists to prevent. The picker prints the
	// reason; this is what stops the Start button.
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
		initial.carried,
		{ budgets: initial.budgets, customBudgets: initial.customBudgets },
		{ budgets, customBudgets }
	);
	const carriedSummary = describeCarried(carried, budgets, customBudgets, initial.budgetsFrom);

	const clearCarriedBudgets = () => {
		const cleared = clearCarried(carried, budgets, customBudgets);
		setBudgets(cleared.budgets);
		setCustomBudgets(cleared.customBudgets);
	};

	const notices = buildNotices({
		...errors,
		hasPreRequestScript,
		hasPostRequestScript,
		scriptsOverride,
		defaultHeaderDifference,
		remoteTarget,
		carriedBudgets: carriedSummary
			? { summary: carriedSummary, onClear: clearCarriedBudgets }
			: null,
	});

	/**
	 * The memo's budgets are attributed to this request only when this Start is
	 * what changed them; an untouched carry keeps naming whoever set it.
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
			budgets,
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
				maxInFlight: maxInFlightValue,
				budgets,
				customBudgets,
				failRun,
				monitor,
				comment,
				carriedBudgets: carriedThresholdKeys(carried, customBudgets),
				scriptsOverride,
				dataFile: dataFile.file,
				isStreamingRequest,
			})
		);
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-xl lg:max-w-4xl">
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
						A request times out after Default request timeout (Settings › Network &amp;
						connectivity). To pace virtual users, add a Think time element on the
						request&apos;s Elements tab.
					</p>
				</DialogHeader>

				{/*
				 * Pinned between header and body, not inside the scroller: a blocking
				 * notice explains why Start is disabled, and in a two-pane body it would
				 * scroll out of sight with the column it sits in. Capped so a stack of
				 * them cannot take the fields' height. `-mx-1 px-1 py-px` is DialogBody's
				 * clearance (#1627), so a focused notice button's ring is not clipped.
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
							 * First field in the dialog, not the last one inside "Recording
							 * & limits": naming the run is what a user does before picking
							 * its profile, not an afterthought behind a collapsed advanced
							 * section - a comment written after the run started is a comment
							 * about a run already forgotten which one it was.
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
								<Label className="text-xs">Load profile</Label>
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
					{/* The OAuth2 gate is the one worth a hint: the guard above says
					    what is wrong, but it collapses, and Start then reads as
					    broken. `blockingError` is already on screen beside the field
					    it belongs to, so the reason here only has to point at it. */}
					<DisabledHint
						reason={
							isStarting
								? "Starting the run…"
								: blockingError !== null
									? "Fix the highlighted setting above."
									: oauthGated && "The OAuth 2.0 token check above hasn't passed."
						}
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

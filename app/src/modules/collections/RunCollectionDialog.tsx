/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Starts a collection run. The scenario *is* the folder: the sequence is its requests by `order`
 * (with Recursive, its sub-folders and requests as one list by the shared `order`, depth-first, a
 * sub-folder's whole subtree where it sits, #2535), the order the sidebar shows. No step list is
 * authored here; one would be a second source of truth for an ordering the tree owns.
 *
 * The engine resolves the whole plan before answering, so a collection with no requests, a step
 * that will not compose, or a plan over `maxScenarioSteps` comes back as a `400` with no run
 * created, shown here rather than as a toast because it names the step to fix.
 *
 * A **data file** (issue #402) changes what Iterations means: with rows and no explicit count, the
 * run is one pass per row. The file pre-filled and the columns diffed against come from the
 * contract *in scope*, the nearest declared ancestor (issue #729): a sub-collection run under a
 * declaring parent binds the parent's rows. The rows ride the payload and are dropped on unmount;
 * they are user data of unknown sensitivity, so neither side stores the set. A bound cell reaches
 * the request it was substituted into, which the run stores with that step's exchange (issue #731).
 * A **load** run binds the same rows one per iteration, from a cursor every virtual user shares,
 * wrapping for as long as the run lasts (issue #449), so the picker is told which run it is for
 * rather than being wrong about one.
 *
 * **Load test** (issue #357) is a different *executor* over the same plan: `concurrency` virtual
 * users each walking the sequence with their own cookies, closed-loop, on the event loop. The
 * switch lives here, not in the request builder's `LoadTestConfigDialog`, whose target is the open
 * request; a scenario's target is a folder, picked here, and a collection picker there would be a
 * second way to choose a scenario beside the tree that owns the choice.
 *
 * **Fail steps on schema errors** (issue #720) is the renderer's only writer of the engine's
 * `failOnSchemaError`; MCP's `run_collection` is the other (issue #766), with the same top-level
 * key and omitted-when-off rule, so agent and dialog runs are stored alike. It sits on the run, not
 * on a request or the collection, because it decides what "failed" means for *this* run's report,
 * which records it.
 *
 * **Stop the iteration on a script error** (issue #2526) writes the engine's `stopOnError` on the
 * same terms: top-level, design mode only, omitted when off. Off is the engine's default and
 * Postman's: a step whose script threw is reported on its step and the iteration walks on.
 *
 * **Pass/fail budgets** (issue #1564, at their state below), and **the stream caps** (issue #3235),
 * shown only when a request the run sends has `stream` set, load test or not. The engine reads
 * whether a step streams off each stored request, so the run sends no `stream` (a `400` on a
 * collection run) and carries only the two top-level caps, which bound the streaming steps and
 * nothing else.
 *
 * **Wait out Retry-After** (issue #3799), the request dialog's engine option, in load mode only:
 * the design-mode runner has no virtual user to hold back. Drawn by the shared `RetryAfterFields`,
 * kept in the profile state (reset on every mount, like the rest) and sent only while on.
 *
 * A scenario has only the three closed-loop modes (`SCENARIO_LOAD_MODES`), so the profile is the
 * request dialog's `ProfilePicker` and `ProfileFields` narrowed to them. `constant_rps` is a `400`
 * engine-side (an open-loop arrival rate over a multi-step sequence is an arrival-rate executor,
 * which Vayu does not implement), and Capacity Discovery judges one p99 where a sequence has one
 * per step. The profile starts from the dialog's own numbers and is never read from or written to
 * the request dialog's saved config: that memo describes one request, and a sequence multiplies its
 * load.
 */

import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogBody,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
	Button,
	Input,
	Label,
	Switch,
	ToggleGroup,
	ToggleGroupItem,
	DialogCancelButton,
	DisabledHint,
	ICON_MOTION,
} from "@/components/ui";
import { resolveLoadTestLimits } from "@/constants/load-test";
import { COLLECTION_ITERATIONS_LABEL } from "@/constants/load-test-modes";
import { Callout, NumberField, StopRunButton } from "@/components/shared";
import {
	useCollectionsQuery,
	useFullCollectionRequests,
	useStartScenarioRunMutation,
} from "@/queries";
import {
	runningRunSentence,
	runningRunTab,
	useCanStartLoadRun,
	useClientSettingsStore,
	useDashboardStore,
	useSessionStore,
	useTabsStore,
} from "@/stores";
import { loadTestService, scenarioRunService } from "@/services";
import { describeDataSchemaDiff, describeUnboundReferences } from "@/services/data-files";
import { useStopLiveRun } from "@/hooks/useStopLiveRun";
import { useDeclaredDataFile } from "@/hooks/useDeclaredDataFile";
import { runDataFileName } from "@/lib/run-data-file";
import { useDataContractWriter } from "@/hooks/useDataContractWriter";
import { useColumnAudit } from "@/hooks/useColumnAudit";
import type { Collection } from "@/types";
import {
	BUDGETS_EXPLAINER,
	STREAM_LATENCY_NOTE,
	STREAM_LATENCY_NOTE_AFTER,
	budgetFieldsFor,
	summariseBudgets,
	type BudgetDraft,
	type CustomBudgetDraft,
	budgetError,
	buildThresholds,
	customBudgetsError,
	emptyBudgetDraft,
} from "@/modules/request-builder/components/LoadTestConfigDialog/budgets";
import { DisclosureCard } from "@/modules/request-builder/components/LoadTestConfigDialog/DisclosureCard";
import {
	CustomBudgetHint,
	CustomBudgetRows,
} from "@/modules/request-builder/components/LoadTestConfigDialog/CustomBudgetRows";
import OAuth2LoadTestGuard from "@/modules/request-builder/components/OAuth2LoadTestGuard";
import { OAUTH2_GATE_REASON } from "@/modules/request-builder/components/oauth2-load-test-coverage";
import { usesDuration } from "@/modules/request-builder/components/LoadTestConfigDialog/profile";
import { ProfileFields } from "@/modules/request-builder/components/LoadTestConfigDialog/ProfileFields";
import { RetryAfterFields } from "@/modules/request-builder/components/LoadTestConfigDialog/RetryAfterFields";
import { StreamCapFields } from "@/modules/request-builder/components/LoadTestConfigDialog/StreamCapFields";
import {
	ProfilePicker,
	type ProfilePickerCopy,
} from "@/modules/request-builder/components/LoadTestConfigDialog/ProfilePicker";
import {
	SCENARIO_LOAD_MODES,
	SCENARIO_PROFILE_DEFAULTS,
	isScenarioLoadMode,
	scenarioLoadFields,
	scenarioProfileError,
	scenarioStreamCapError,
	scenarioStreamCaps,
	type ScenarioLoadProfile,
} from "@/modules/request-builder/components/LoadTestConfigDialog/scenarioProfile";
import { summarise } from "@/modules/request-builder/components/LoadTestConfigDialog/summary";
import type { LoadTestProfile } from "@/modules/request-builder/components/LoadTestConfigDialog/useSavedLoadTestConfig";
import DataFilePicker, { type SelectedDataFile } from "./DataFilePicker";
import { collectSubtreeIds } from "./tree-utils";
import { useRunOAuth2Configs } from "./useRunOAuth2Configs";
import type { RunOAuth2Config } from "./runOAuth2Configs";

export interface RunCollectionDialogProps {
	/**
	 * The collection to run. Non-null: the caller mounts this only once a folder is chosen and
	 * unmounts it on close, and that mount **is** the reset. The options start at their defaults
	 * every time, where an always-mounted dialog would silently carry the previous folder's
	 * Recursive and Iterations, and a reset in an effect would be a cascading render for what React
	 * models as identity.
	 */
	collection: Collection;
	onOpenChange: (open: boolean) => void;
	/**
	 * Where focus goes on close. Radix restores it to whatever held it before the dialog opened,
	 * which for a dialog opened from a row's menu is a menu item that is gone, so focus lands on
	 * `<body>` (#3443). A caller that knows the row calls `preventDefault` and focuses it.
	 */
	onCloseAutoFocus?: (event: Event) => void;
}

/** Matches the engine's `iterations` bound: a whole number, 1 or more. */
const MIN_ITERATIONS = 1;

const SEQUENCE_PROFILE_COPY: ProfilePickerCopy = {
	iterations: {
		label: COLLECTION_ITERATIONS_LABEL,
		description: "Walk the sequence an exact number of times in total, then stop.",
	},
};

/**
 * The `elements` run override (issue #1495). `timers` applies to every collection run, load test or
 * not: `RunContext`'s constructor reads it off the payload whatever the run shape
 * (`run_manager.cpp`), and `timer.pacing`/`timer.think` honour it in the sequential runner as under
 * load (issue #1552's reopen). Under load `"off"` reaches every `timer.*` kind (#1498's reopen
 * fix), but `fixedMs`/`{minMs, maxMs}` do not yet reach `timer.pacing`/`timer.throughput` there
 * (#1620); the sequential run has no such gap, as it has no separate pre-scheduling hook to thread
 * the override through. `scripts` stays load-only: the design send and the sequential run already
 * run every `script.*` element inline, so inline vs deferred means nothing until a run is on the
 * event loop. Matches `docs/engine/api-reference/load-runs.md`'s "elements" block.
 */
const TIMERS_DEFAULT = "asConfigured";
const SCRIPTS_DEFAULT = "asMarked";

const NO_COLUMNS: string[] = [];
const NO_COLLECTION_IDS: string[] = [];

/**
 * One token's check, its own component so the gate callback keeps its identity across renders (the
 * guard reports in an effect keyed on it). Without the per-request `OAuth2DeferredNote`: it asks
 * `/compose` about one request, and a run's steps are many.
 */
function RunTokenGuard({
	entry,
	durationSeconds,
	onGateChange,
}: {
	entry: RunOAuth2Config;
	durationSeconds: number;
	onGateChange: (key: string, gated: boolean) => void;
}) {
	const { key, config, collectionId } = entry;
	const report = useCallback((gated: boolean) => onGateChange(key, gated), [onGateChange, key]);
	return (
		<OAuth2LoadTestGuard
			config={config}
			durationSeconds={durationSeconds}
			collectionId={collectionId}
			onGateChange={report}
		/>
	);
}

/**
 * The line under the title. Per mode when the switch is on: Fixed passes ends
 * on a pass count, so "repeating for the duration" would be untrue of it.
 */
function describeRun(loadTest: boolean, mode: ScenarioLoadProfile["mode"]): string {
	const carry = "Variables and cookies carry from one step to the next.";
	if (!loadTest) {
		return `Every request in this collection runs in order, once per iteration. ${carry}`;
	}
	const until =
		mode === "iterations"
			? "taking passes until the total is reached"
			: "repeating for the duration";
	return `Each virtual user walks every request in this collection in order, ${until}. ${carry}`;
}

export default function RunCollectionDialog({
	collection,
	onOpenChange,
	onCloseAutoFocus,
}: RunCollectionDialogProps) {
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const openTab = useTabsStore((s) => s.openTab);
	const startRun = useStartScenarioRunMutation();

	const [recursive, setRecursive] = useState(false);
	const [iterations, setIterations] = useState("1");
	/*
	 * Whether the user has typed in Iterations, which the value cannot say: a typed `1` and the
	 * untouched default read alike, and clearing a chosen `1` on a file pick would silently turn
	 * "run this sequence once" into a pass per row.
	 *
	 * A ref, not state: nothing renders from it, and the pre-fill below resolves asynchronously, so
	 * a state value in that effect's closure would be the mount's and clear a `1` typed while the
	 * file was being read.
	 */
	const iterationsTouched = useRef(false);
	const [dataFileError, setDataFileError] = useState<string | null>(null);
	const [loadTest, setLoadTest] = useState(false);
	/**
	 * Whether the bound contract gates this run (issue #720). Off by default, the engine's default
	 * and the #628-era decision: a schema verdict is its own channel, and folding it into the step
	 * outcome would make every undocumented field look like a broken test.
	 */
	const [failOnSchemaError, setFailOnSchemaError] = useState(false);
	/**
	 * Whether an errored step ends its iteration (issue #2526). Off by default,
	 * the engine's own: the iteration carries on past a step whose script threw
	 * or that got no response.
	 */
	const [stopOnError, setStopOnError] = useState(false);
	const [profile, setProfile] = useState<ScenarioLoadProfile>(SCENARIO_PROFILE_DEFAULTS);
	const ceilings = useClientSettingsStore((s) => s.loadTestCeilings);
	const limits = useMemo(() => resolveLoadTestLimits(ceilings), [ceilings]);
	// The mode is kept out of the patch: `ProfileFields` edits numbers only, and
	// the picker's handler below is the one place a mode is chosen (and narrowed).
	const updateProfile = (patch: Partial<LoadTestProfile>) =>
		setProfile((prev) => ({ ...prev, ...patch, mode: prev.mode }));
	const [timersOverride, setTimersOverride] = useState<"asConfigured" | "off">(TIMERS_DEFAULT);
	const [scriptsOverride, setScriptsOverride] = useState<
		"asMarked" | "allInline" | "allDeferred"
	>(SCRIPTS_DEFAULT);
	/**
	 * Pass/fail budgets (issue #1564), with `LoadTestConfigDialog`'s disclosure and payload shape
	 * (shared in `budgets.ts`): a collection run is judged against them too, load test or not.
	 */
	const [budgets, setBudgets] = useState<BudgetDraft>(emptyBudgetDraft);
	/**
	 * The `custom.<name>.<stat>` rows (issue #1579), judged for a design-mode collection run as the
	 * six fixed budgets are (issue #1564): `execute_scenario_run` folds `summary.custom_metrics`
	 * into the `RunSummaryInputs` it evaluates thresholds against in every run mode
	 * (`scenario_runner.cpp`). Not gated on the switch.
	 */
	const [customBudgets, setCustomBudgets] = useState<CustomBudgetDraft[]>([]);
	const [failRun, setFailRun] = useState(false);
	const [budgetsOpen, setBudgetsOpen] = useState(false);

	/*
	 * The contract this run is measured against, resolved through the chain rather than read off
	 * the collection being run (issue #729): the nearest declared ancestor, the documented rule
	 * (`docs/app/variable-resolution.md`) and the engine's at plan time, so under a declaring
	 * parent the file to pre-fill and the columns to diff against are the parent's. Keyed as
	 * `useSendWithRow` keys its own read, by the collection that *declared* the contract (the one a
	 * pick declares for), falling back to this collection's id, which the store holds when no
	 * contract is in scope.
	 *
	 * Also the file that contract last ran with, pre-filled (issue #599; through the chain, #729;
	 * shared with the load dialog, #1039). Part of the mount-is-reset contract: one default is "the
	 * file you declared", not a value carried from a previous open. The hook owns the one-attempt
	 * rule, the row cap and the moved-file note; this dialog keeps the iterations coupling below, a
	 * fact about the engine's default for a collection run, not about the file.
	 *
	 * `collection` is passed because the row this dialog opened with is ahead of the query's copy
	 * of itself: the walk must find a contract it declares even before the query answers.
	 */
	const {
		file: dataFile,
		setFile: setDataFile,
		note: prefillNote,
		contract,
		dismissNote,
		declaringCollectionId,
	} = useDeclaredDataFile(collection.id, {
		collection,
		// Same rule as a hand-picked file: a pristine `1` becomes "one pass per row", a typed one
		// is the user's. On `onPrefill`, not in the hook: it is the engine's default for a
		// *collection* run, and the load dialog shares the pre-fill but must not share this.
		onPrefill: () => {
			if (!iterationsTouched.current) {
				setIterations((current) => (current === "1" ? "" : current));
			}
		},
	});

	const writer = useDataContractWriter(declaringCollectionId);

	/*
	 * The requests this run sends: the collection's own and, with Recursive, every descendant's,
	 * including one declaring its own contract, since a run binds one data set to every step
	 * whatever each folder declares. Hence not `collectionsUnderContract`.
	 */
	const { data: collections = [] } = useCollectionsQuery();
	const auditedCollectionIds = useMemo(
		() => (recursive ? collectSubtreeIds(collection.id, collections) : [collection.id]),
		[recursive, collection.id, collections]
	);
	const fileColumns = dataFile?.parsed.columns ?? NO_COLUMNS;
	const { audit } = useColumnAudit(auditedCollectionIds, fileColumns);
	/*
	 * Whether any request this run sends streams (#3235): the engine reads the flag off each stored
	 * request, so the run declares nothing and the stream caps are offered only when a step exists
	 * for them to bound. The audit's full-row query, which TanStack dedupes.
	 */
	const { requestsByCollection } = useFullCollectionRequests(auditedCollectionIds);
	const anyStreams = auditedCollectionIds.some((id) =>
		requestsByCollection.get(id)?.some((request) => request.stream)
	);

	/*
	 * Only a duration-based load run can be cut short by a token's lifetime (issue #3199): the
	 * engine keeps one credential per distinct token the requests send, and the guard says whether
	 * each stays valid for the whole run. A pass-count run has no length to judge, so nothing is
	 * asked.
	 */
	const oauth2DurationSeconds = loadTest && usesDuration(profile.mode) ? profile.duration : null;
	const oauth2Configs = useRunOAuth2Configs(
		oauth2DurationSeconds === null ? NO_COLLECTION_IDS : auditedCollectionIds
	);
	/*
	 * Which tokens' guards are gating Run, by cache key. Read back through the
	 * configs on screen, so a guard that unmounts (a different folder set, Load
	 * test switched off) cannot leave a stale entry holding Run disabled.
	 */
	const [gatedKeys, setGatedKeys] = useState<ReadonlySet<string>>(new Set());
	const reportGate = useCallback((key: string, gated: boolean) => {
		setGatedKeys((prev) => {
			if (prev.has(key) === gated) return prev;
			const next = new Set(prev);
			if (gated) next.add(key);
			else next.delete(key);
			return next;
		});
	}, []);
	const oauthGated = oauth2Configs.some(({ key }) => gatedKeys.has(key));

	/*
	 * Empty means something only with a data file: "one pass per row", the engine's default when
	 * `iterations` is absent from the payload. Without a file there is no row count to fall back
	 * to, so empty is invalid.
	 */
	const iterationsBlank = iterations.trim() === "";
	const explicitIterations = iterationsBlank ? undefined : Number(iterations);
	const iterationsValid =
		explicitIterations === undefined
			? !!dataFile
			: Number.isInteger(explicitIterations) && explicitIterations >= MIN_ITERATIONS;

	/*
	 * A load run is shaped by its profile, not by the design-mode `iterations` (Fixed passes has
	 * its own pass count). Refused here rather than engine-side, and against the Settings ceilings
	 * the engine does not know, so the user sees what is wrong while the field still has focus.
	 */
	const profileError = scenarioProfileError(profile, limits);
	const streamCapsError = anyStreams ? scenarioStreamCapError(profile, limits) : null;

	// The stream budgets are judged on the report's `stream` section, which only
	// a run with a streaming step has; read off `anyStreams` like the caps, so a
	// value typed while one was in scope is neither checked nor sent once none is.
	const budgetsError = budgetError(budgets, anyStreams) ?? customBudgetsError(customBudgets);

	const settingsValid = loadTest
		? !profileError && !streamCapsError && !dataFileError && !budgetsError
		: iterationsValid && !streamCapsError && !dataFileError && !budgetsError;
	// Any run, load or sequence, waits for the live run that holds the stream
	// (`canStartLoadRun`, #3351, #3381); Stop in the callout is the way through.
	const loadRunGate = useCanStartLoadRun();
	const heldBy = loadRunGate.ok ? null : loadRunGate.running;
	const { stop: stopHeldRun, isStopping: isStoppingHeldRun } = useStopLiveRun();
	const canRun = settingsValid && !oauthGated && !heldBy;

	/*
	 * The chosen file against the contract in scope (issue #599) and the requests this run sends
	 * (issue #2050). Warnings, never blockers: a referenced column the file lacks fails loudly
	 * engine-side at bind time, and extra columns are just extra columns; the gain is hearing it
	 * here, not at iteration 1. The contract diff is for a pre-filled file that drifted on disk;
	 * after a pick's declare it is empty by construction, leaving the requests to compare against.
	 */
	const fileWarnings = dataFile
		? [
				...describeDataSchemaDiff(contract?.columns ?? [], dataFile.parsed.columns),
				...describeUnboundReferences(audit.undeclared),
			]
		: [];

	/*
	 * A pick declares the contract from the picked file (issue #2050), for the collection whose
	 * contract this run binds against; Remove clears it through the picker's `onRemove`, because a
	 * file the picker refuses also arrives here as `null` and must leave the contract alone. The
	 * pre-fill never comes through here, so reopening the dialog writes nothing. A failed declare
	 * leaves the selection: the run still sends the previewed rows, and picking again is the retry.
	 *
	 * A pick also clears the *pristine* `1`, so the field shows what the run will do (one pass per
	 * row) rather than contradicting the preview above it. A typed count, a typed `1` included, is
	 * the user's; hence the touched flag, not the value.
	 */
	const handleSelectDataFile = (next: SelectedDataFile | null) => {
		setDataFile(next);
		if (next) {
			// A hand-picked file replaces the pre-fill, so the note about a file that could not be
			// re-read has nothing left to say.
			dismissNote();
			writer.declare(next);
		}
		if (next && !iterationsTouched.current && iterations === "1") setIterations("");
		if (!next && iterationsBlank) setIterations("1");
	};

	/*
	 * "Read numbers as numbers" re-parsed the same file: not a pick, so nothing
	 * is declared and Iterations is left alone (the row count cannot change).
	 * The binding remembers the reading, for the next pre-fill.
	 */
	const handleCastNumbersChange = (next: SelectedDataFile) => {
		setDataFile(next);
		writer.rememberReading(next);
	};

	const handleRun = () => {
		if (!canRun) return;
		const thresholds = buildThresholds(budgets, failRun, customBudgets, anyStreams);
		// Top-level, where the engine reads it (`validate_elements_run_override` reads the run
		// payload, not `scenario`), and, unlike `mode`/`concurrency`/`duration` below, not gated by
		// `loadTest`: the sequential runner honours `timers` too. Each field is omitted at the
		// engine's default, the "absent already means what the user asked for" rule
		// `failOnSchemaError` follows below.
		const elementsOverride = {
			...(timersOverride !== TIMERS_DEFAULT ? { timers: timersOverride } : {}),
			...(loadTest && scriptsOverride !== SCRIPTS_DEFAULT
				? { scripts: scriptsOverride }
				: {}),
		};
		const loadFields = loadTest ? scenarioLoadFields(profile) : null;
		// Read at Run, never held in the profile: a cap typed while a streaming
		// step was in scope (Include nested collections on) is dropped when the
		// scope no longer has one, rather than sent as a bound nothing applies.
		const streamCaps = anyStreams ? scenarioStreamCaps(profile) : null;
		startRun.mutate(
			{
				/*
				 * `mode`'s presence is what makes this a load run (the engine reads exactly that),
				 * so a design-mode payload carries no mode rather than a "not a load run" flag.
				 * `iterations` here is the top-level pass total (Fixed passes); the design-mode
				 * count rides inside `scenario` below, only with the switch off.
				 */
				...loadFields,
				...streamCaps,
				...(Object.keys(elementsOverride).length > 0 ? { elements: elementsOverride } : {}),
				scenario: {
					source: "collection",
					collectionId: collection.id,
					recursive,
					// Omitted, not sent as the row count: the engine resolves the default, and a
					// client that computed its own would be a second copy of a rule only one side
					// can enforce. Design mode only: a load run takes its shape from the profile
					// (Fixed passes sends its own top-level total).
					...(!loadTest && explicitIterations !== undefined
						? { iterations: explicitIterations }
						: {}),
					// The parsed rows (the array the preview showed, never a re-parse), which file
					// they came from by name and content hash, never path (#2051), and how it was
					// read (#2540).
					...(dataFile
						? {
								data: dataFile.parsed.rows,
								dataFileName: runDataFileName(dataFile.fileName),
								dataFileHash: dataFile.hash,
								dataFileCastNumbers: dataFile.parsed.castNumbers,
							}
						: {}),
				},
				// The environment the rest of the app sends against - a run that
				// resolved `{{variables}}` against a different one than Send does
				// would be a different request wearing the same name.
				...(activeEnvironmentId ? { environmentId: activeEnvironmentId } : {}),
				// Sent only when the user asked for the gate: the engine's default is off, so
				// absent says what `false` would, and the run snapshot carries the key exactly when
				// it changed what "failed" means in the report. Never on a load run: only the
				// design-mode runner demotes a step on a schema failure (the load executor
				// validates once the run has drained), so a load payload carrying it would promise
				// a gate nothing applies.
				...(!loadTest && failOnSchemaError ? { failOnSchemaError: true } : {}),
				// Same two rules as the key above: omitted when off, and never on a
				// load run, whose executor does not read it.
				...(!loadTest && stopOnError ? { stopOnError: true } : {}),
				// Top-level like `elements` and `failOnSchemaError`, on the same "absent says what
				// the user asked for" rule: `buildThresholds` returns `undefined` with nothing
				// declared, so a run from an untouched dialog is measured but not judged (#1564).
				...(thresholds ? { thresholds } : {}),
			},
			{
				onSuccess: ({ runId }) => {
					// Attach before the tab opens: the stream replays from offset 0, so nothing is
					// missed either way, and the tab finds the store already pointed at this run.
					// Which stream depends on the executor: a design-mode run emits one `step`
					// event per step execution and no metric ticks, a load run ticks at 10 Hz and
					// emits no steps, and the wrong listener is a permanently empty view, not a
					// degraded one. So the dashboard takes a load run and the runner tab a
					// sequence.
					if (loadFields) {
						// The object the engine was sent, so the dashboard shows the
						// mode and ramp the run was started with.
						useDashboardStore.getState().startRun(runId, {
							...loadFields,
							latencyP99Ms: thresholds?.latencyP99Ms,
							dataRowCount: dataFile?.parsed.rows.length,
							dataFileName: dataFile?.fileName,
							dataFileHash: dataFile?.hash,
							dataFileCastNumbers: dataFile?.parsed.castNumbers,
						});
						loadTestService.startMonitoring(runId);
						openTab({ type: "dashboard", entityId: null });
					} else {
						scenarioRunService.startMonitoring(runId);
						openTab({ type: "run", entityId: runId });
					}
					onOpenChange(false);
				},
			}
		);
	};

	const error = startRun.error;

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl" onCloseAutoFocus={onCloseAutoFocus}>
				<DialogHeader>
					<DialogTitle>Run {collection.name}</DialogTitle>
					<DialogDescription>{describeRun(loadTest, profile.mode)}</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-4 py-2">
					<div className="flex items-center justify-between gap-4">
						<Label htmlFor="run-collection-recursive" className="leading-snug">
							Include nested collections
							<span className="block text-xs font-normal text-muted-foreground">
								Descend into nested collections. Each one runs before its
								parent&apos;s own requests, top to bottom as the sidebar shows them.
							</span>
						</Label>
						<Switch
							id="run-collection-recursive"
							checked={recursive}
							onCheckedChange={setRecursive}
						/>
					</div>

					<div className="flex items-center justify-between gap-4">
						<Label htmlFor="run-collection-load" className="leading-snug">
							Load test
							<span className="block text-xs font-normal text-muted-foreground">
								Run the sequence as a load test: each virtual user walks it
								independently, with its own cookies and its own data row.
							</span>
						</Label>
						<Switch
							id="run-collection-load"
							checked={loadTest}
							onCheckedChange={setLoadTest}
						/>
					</div>

					{loadTest && (
						<>
							<div className="space-y-1.5">
								<span className="block text-xs font-medium leading-none">
									Load profile
								</span>
								<ProfilePicker
									value={profile.mode}
									onChange={(next) => {
										if (isScenarioLoadMode(next)) {
											setProfile((prev) => ({ ...prev, mode: next }));
										}
									}}
									modes={SCENARIO_LOAD_MODES}
									copy={SEQUENCE_PROFILE_COPY}
									disabled={startRun.isPending}
								/>
							</div>

							<ProfileFields
								profile={profile}
								onChange={updateProfile}
								limits={limits}
								isStreamingRequest={anyStreams}
								iterationsLabel="Passes through the sequence"
							/>

							<p className="rounded-md border border-border bg-panel px-3 py-2 text-label leading-relaxed text-muted-foreground">
								{summarise(profile, profileError !== null, "sequence")}
							</p>

							{(profileError ?? streamCapsError) && (
								<Callout severity="blocking" title="Load test">
									{profileError ?? streamCapsError}
								</Callout>
							)}

							<RetryAfterFields
								mode={profile.mode}
								limits={limits}
								idPrefix="run-collection"
								backoff={profile.retryAfterBackoff}
								onBackoffChange={(retryAfterBackoff) =>
									setProfile((prev) => ({ ...prev, retryAfterBackoff }))
								}
								maxMs={profile.retryAfterMaxMs}
								onMaxMsChange={(retryAfterMaxMs) =>
									setProfile((prev) => ({ ...prev, retryAfterMaxMs }))
								}
							/>

							<div className="flex items-center justify-between gap-4">
								<span className="block text-sm font-medium leading-snug">
									Scripts
									<span className="block text-xs font-normal text-muted-foreground">
										As marked runs a script inline only where its own element
										says to; the other two override every script this run.
									</span>
								</span>
								<ToggleGroup
									size="sm"
									aria-label="Scripts"
									value={scriptsOverride}
									onValueChange={(value) => {
										if (
											value === "asMarked" ||
											value === "allInline" ||
											value === "allDeferred"
										) {
											setScriptsOverride(value);
										}
									}}
								>
									<ToggleGroupItem value="asMarked">As marked</ToggleGroupItem>
									<ToggleGroupItem value="allInline">All inline</ToggleGroupItem>
									<ToggleGroupItem value="allDeferred">
										All deferred
									</ToggleGroupItem>
								</ToggleGroup>
							</div>
						</>
					)}

					{/*
					 * A load run shows the caps inside its profile fields; a design
					 * run has no profile, but its streaming steps are bounded by the
					 * same two numbers (#3235).
					 */}
					{!loadTest && anyStreams && (
						<>
							<div className="grid grid-cols-2 gap-3">
								<StreamCapFields
									profile={profile}
									onChange={updateProfile}
									limits={limits}
								/>
							</div>
							{streamCapsError && (
								<Callout severity="blocking" title="Stream caps">
									{streamCapsError}
								</Callout>
							)}
						</>
					)}

					{/* Not gated by Load test, unlike Scripts above: the sequential
					    runner honours `elements.timers` exactly as the load
					    executor does (issue #1552's reopen), so a design-mode run
					    can silence or override its timers too. */}
					<div className="flex items-center justify-between gap-4">
						<span className="block text-sm font-medium leading-snug">
							Timers
							<span className="block text-xs font-normal text-muted-foreground">
								As configured, or off for this run.
							</span>
						</span>
						<ToggleGroup
							size="sm"
							aria-label="Timers"
							value={timersOverride}
							onValueChange={(value) => {
								// Radix emits "" when the active segment is
								// clicked again; a choice is not optional here.
								if (value === "asConfigured" || value === "off") {
									setTimersOverride(value);
								}
							}}
						>
							<ToggleGroupItem value="asConfigured">As configured</ToggleGroupItem>
							<ToggleGroupItem value="off">Off</ToggleGroupItem>
						</ToggleGroup>
					</div>

					{/*
					 * Pass/fail budgets (issue #1564). Not gated by `loadTest`, unlike Scripts
					 * above: the engine judges a design-mode collection run against the six fixed
					 * budgets as it does a load run, and the custom rows inside follow the same
					 * rule. Card treatment as in `LoadTestConfigDialog`, for its reason: fields
					 * revealed loose on the dialog background would read as unrelated to what
					 * disclosed them.
					 */}
					<DisclosureCard
						open={budgetsOpen}
						onOpenChange={setBudgetsOpen}
						title="Pass/fail budgets"
						summary={summariseBudgets(budgets, customBudgets, anyStreams)}
					>
						<p className="text-label leading-relaxed text-muted-foreground">
							{BUDGETS_EXPLAINER}
						</p>
						{budgetFieldsFor(anyStreams).map((field) => (
							<Fragment key={field.key}>
								<NumberField
									id={`run-collection-${field.id}`}
									label={field.label}
									unit={field.unit}
									optional
									value={budgets[field.key]}
									onChange={(raw) =>
										setBudgets((prev) => ({ ...prev, [field.key]: raw }))
									}
									min={field.min}
									max={field.max}
									placeholder="No budget"
									hint={field.hint}
								/>
								{anyStreams && field.key === STREAM_LATENCY_NOTE_AFTER && (
									<p className="text-label leading-relaxed text-muted-foreground">
										{STREAM_LATENCY_NOTE}
									</p>
								)}
							</Fragment>
						))}

						{/*
						 * Custom metric budgets, not gated by `loadTest` either:
						 * `custom.<name>.<stat>` is judged for a design-mode collection run as for
						 * a load run (`execute_scenario_run`; #1564's every-run-mode rule covers
						 * #1500's custom metrics).
						 */}
						<div className="space-y-1.5">
							<span className="block text-xs font-medium leading-none">
								Custom metric budgets
								<span className="ml-1 font-normal text-muted-foreground">
									(optional)
								</span>
							</span>
							<CustomBudgetHint />
							<CustomBudgetRows
								rows={customBudgets}
								onChange={setCustomBudgets}
								idPrefix="run-collection"
								disabled={startRun.isPending}
							/>
						</div>

						<div className="flex items-start justify-between gap-3">
							<Label
								htmlFor="run-collection-fail-run"
								className="text-xs font-normal leading-snug"
							>
								Fail the run when a budget is missed
								<span className="block text-label text-muted-foreground">
									Otherwise a missed budget is reported but the run still ends
									Completed.
								</span>
							</Label>
							<Switch
								id="run-collection-fail-run"
								checked={failRun}
								onCheckedChange={setFailRun}
							/>
						</div>
					</DisclosureCard>

					{budgetsError && (
						<Callout severity="blocking" title="A budget is out of range">
							{budgetsError}
						</Callout>
					)}

					{/* A load run takes its count from the profile above, so this
					    design-mode pass count is hidden rather than shown
					    disabled - a greyed field still reads as "this applies, but
					    not now". */}
					{!loadTest && (
						<>
							<div className="flex items-center justify-between gap-4">
								<Label htmlFor="run-collection-iterations" className="leading-snug">
									Iterations
									<span className="block text-xs font-normal text-muted-foreground">
										{dataFile
											? "How many times to run the whole sequence. Leave empty for one pass per row."
											: "How many times to run the whole sequence."}
									</span>
								</Label>
								<Input
									id="run-collection-iterations"
									type="number"
									min={MIN_ITERATIONS}
									step={1}
									value={iterations}
									placeholder={
										dataFile ? String(dataFile.parsed.rows.length) : undefined
									}
									onChange={(e) => {
										iterationsTouched.current = true;
										setIterations(e.target.value);
									}}
									// Fixed rem, not `w-24`: same text-measure reasoning as
									// virtual users above.
									className="w-[6rem] shrink-0"
									aria-invalid={!iterationsValid}
								/>
							</div>

							{/* Refused here rather than sent and refused by the engine: a
							    fraction or a 0 is a run nobody asked for, and the user can
							    see what is wrong while the field still has focus. */}
							{!iterationsValid && (
								<Callout severity="blocking" title="Iterations">
									Enter a whole number of 1 or more.
								</Callout>
							)}
						</>
					)}

					{/* Hidden for a load run rather than shown disabled, for the same
					    reason Iterations is: only the design-mode runner can honour it,
					    so offering it there would be a promise the executor does not
					    keep. Shown for every design-mode run, bound or not - the app
					    resolves a binding through the collection chain engine-side at
					    plan time, and a dialog that guessed at it would refuse the
					    option to a collection whose parent carries the document. */}
					{!loadTest && (
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="run-collection-fail-on-schema" className="leading-snug">
								Fail steps on schema errors
								<span className="block text-xs font-normal text-muted-foreground">
									Make the OpenAPI contract a gate: a step that passed everything
									else, whose response does not match the schema the bound
									document declares, is failed. Off, the verdict still shows on
									the step - it just does not change the outcome.
								</span>
							</Label>
							<Switch
								id="run-collection-fail-on-schema"
								checked={failOnSchemaError}
								onCheckedChange={setFailOnSchemaError}
							/>
						</div>
					)}

					{/* Hidden for a load run for the same reason: the scenario load
					    executor never reads `stopOnError`. */}
					{!loadTest && (
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="run-collection-stop-on-error" className="leading-snug">
								Stop the iteration on a script error
								<span className="block text-xs font-normal text-muted-foreground">
									Off by default: an errored step, a script error or a failed
									connection included, is reported on its step and the iteration
									moves on to the next request, as in Postman.
								</span>
							</Label>
							<Switch
								id="run-collection-stop-on-error"
								checked={stopOnError}
								onCheckedChange={setStopOnError}
							/>
						</div>
					)}

					{/* A file that could not be re-read is a warning, not a blocker -
					    the run is startable without one, and picking the file again
					    is the whole remedy. */}
					{prefillNote && (
						<Callout severity="warning" title="The remembered data file">
							{prefillNote}
						</Callout>
					)}

					{writer.isError && (
						<Callout severity="warning" title="Couldn't update the data contract">
							{writer.error?.message ?? "Vayu's engine didn't accept the change."}
							<span className="block">
								The run is unaffected. Pick the file again to retry.
							</span>
						</Callout>
					)}

					<DataFilePicker
						selected={dataFile}
						onSelect={handleSelectDataFile}
						onCastNumbersChange={handleCastNumbersChange}
						// Only with a contract to clear: Remove on a collection that
						// declares nothing has nothing to write.
						onRemove={contract ? writer.clear : undefined}
						error={dataFileError}
						onError={setDataFileError}
						iterations={explicitIterations}
						loadTest={loadTest}
						additionalWarnings={fileWarnings}
						disabled={startRun.isPending}
					/>

					{/* Under everything it gates and just above Run, as in the request
					    dialog. One per distinct token, not per request. */}
					{oauth2DurationSeconds !== null &&
						oauth2Configs.map((entry) => (
							<RunTokenGuard
								key={entry.key}
								entry={entry}
								durationSeconds={oauth2DurationSeconds}
								onGateChange={reportGate}
							/>
						))}

					{heldBy && (
						<Callout
							severity="blocking"
							title={runningRunSentence(heldBy)}
							action={
								<div className="flex gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											openTab(runningRunTab(heldBy));
											onOpenChange(false);
										}}
									>
										View run
									</Button>
									<StopRunButton
										onStop={() => void stopHeldRun(heldBy)}
										isStopping={isStoppingHeldRun}
									/>
								</div>
							}
						>
							Stop it or let it finish before starting another run.
						</Callout>
					)}

					{error && (
						<Callout severity="blocking" title="Couldn't start the run">
							{error instanceof Error
								? error.message
								: "Vayu's engine refused the run and gave no reason. Try again, or restart Vayu."}
						</Callout>
					)}
				</DialogBody>

				<DialogFooter>
					<DialogCancelButton
						onClick={() => onOpenChange(false)}
						disabled={startRun.isPending}
					/>
					{/* The OAuth 2.0 gate is the one worth a hint: the guard above says
					    what is wrong, but it collapses, and Run then reads as broken.
					    Every other reason is a callout beside its field. */}
					<DisabledHint reason={settingsValid && oauthGated && OAUTH2_GATE_REASON}>
						<Button onClick={handleRun} disabled={!canRun || startRun.isPending}>
							{startRun.isPending ? (
								<Loader2 className="size-icon animate-spin" />
							) : (
								<Play className="size-icon" data-icon-motion={ICON_MOTION.scale} />
							)}
							Run
						</Button>
					</DisabledHint>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

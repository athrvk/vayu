/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RunCollectionDialog
 *
 * Starts a collection run. Two options and nothing else, because the scenario
 * *is* the folder: the sequence is its requests by `order` (and, with
 * Recursive, its sub-folders and requests as one list by the shared `order`,
 * depth-first, a sub-folder's whole subtree where the sub-folder sits, #2535),
 * which is the order the sidebar already shows, top to bottom. There is no step
 * list to author here, and inventing one would be a second source of truth for
 * an ordering the tree already owns.
 *
 * The engine resolves the whole plan before it answers, so a collection with no
 * requests, a step that will not compose, or a plan over `maxScenarioSteps` all
 * come back as a `400` with no run created. That message is shown here rather
 * than as a toast: it names the step that failed, which is the thing the user
 * has to go and fix.
 *
 * A data file is the third option (issue #402), and it changes what Iterations
 * means: with rows and no explicit count, the run is one pass per row. Which
 * file it pre-fills, and which columns that file is diffed against, come from
 * the contract *in scope* - the nearest declared ancestor, as everywhere else
 * in the feature (issue #729): running a sub-collection under a declaring
 * parent binds the parent's rows, so reading the sub-collection's own id left
 * exactly that run with no pre-fill and no diff. The rows
 * ride the payload and are dropped when this dialog unmounts - they are user
 * data of unknown sensitivity, so neither side stores the set. What a bound
 * cell reaches is the request it was substituted into, which the run stores
 * with the rest of that step's exchange (issue #731).
 * A **load** run binds the same rows differently - one per iteration, from a
 * cursor every virtual user shares, wrapping for as long as the run lasts
 * (issue #449) - which is why the picker is told which run it is for rather
 * than describing one of the two and being wrong about the other.
 *
 * **Load test** is the fourth (issue #357), and it is a different *executor*
 * over the same plan: `concurrency` virtual users each walking the sequence with
 * their own cookies, closed-loop, on the event loop. The switch lives here
 * rather than in the request builder's `LoadTestConfigDialog` because that
 * dialog's target is the request that is open; a scenario's target is a folder,
 * and the folder is picked here. Giving that dialog a collection picker would be
 * a second way to choose a scenario beside the tree that already owns the
 * choice.
 *
 * **Fail steps on schema errors** is the fifth (issue #720), and it is the
 * renderer's only writer of the engine's `failOnSchemaError`: the flag was
 * readable in a stored report and settable by nobody, while the docs told users
 * to set it. MCP's `run_collection` is the other writer (issue #766), over the
 * same top-level key and with the same omitted-when-off rule, so a run started
 * by an agent and one started here are stored alike. It belongs on the run
 * rather than on a request or the collection
 * because it decides what "failed" means for *this* run's report, which is
 * where the report records it.
 *
 * **Stop the iteration on a script error** is the sixth (issue #2526), the
 * renderer's writer of the engine's `stopOnError`, on the same terms as the
 * switch above: top-level, design-mode only, omitted when off. Off is the
 * engine's default and Postman's: a step whose script threw is reported on its
 * step and the iteration walks on.
 *
 * Only the three closed-loop modes exist for a scenario (`SCENARIO_LOAD_MODES`),
 * so the load profile is the request dialog's own `ProfilePicker` and
 * `ProfileFields` narrowed to them. `constant_rps` is a `400` engine-side - an
 * open-loop arrival rate over a multi-step sequence is an arrival-rate executor,
 * which Vayu does not implement - and Capacity Discovery judges one p99 where a
 * sequence has one per step. The profile starts from the dialog's own numbers
 * and is neither read from nor written to the request dialog's saved config:
 * that memo describes one request, and a sequence multiplies its load.
 */

import { useMemo, useRef, useState } from "react";
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
	ICON_MOTION,
} from "@/components/ui";
import { resolveLoadTestLimits } from "@/constants/load-test";
import { Callout, NumberField } from "@/components/shared";
import { useCollectionsQuery, useStartScenarioRunMutation } from "@/queries";
import { useClientSettingsStore, useDashboardStore, useSessionStore, useTabsStore } from "@/stores";
import { loadTestService, scenarioRunService } from "@/services";
import { describeDataSchemaDiff, describeUnboundReferences } from "@/services/data-files";
import { useDeclaredDataFile } from "@/hooks/useDeclaredDataFile";
import { runDataFileName } from "@/lib/run-data-file";
import { useDataContractWriter } from "@/hooks/useDataContractWriter";
import { useColumnAudit } from "@/hooks/useColumnAudit";
import type { Collection } from "@/types";
import {
	BUDGETS_EXPLAINER,
	BUDGET_FIELDS,
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
import { ProfileFields } from "@/modules/request-builder/components/LoadTestConfigDialog/ProfileFields";
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
	type ScenarioLoadProfile,
} from "@/modules/request-builder/components/LoadTestConfigDialog/scenarioProfile";
import { summarise } from "@/modules/request-builder/components/LoadTestConfigDialog/summary";
import type { LoadTestProfile } from "@/modules/request-builder/components/LoadTestConfigDialog/useSavedLoadTestConfig";
import DataFilePicker, { type SelectedDataFile } from "./DataFilePicker";
import { collectSubtreeIds } from "./tree-utils";

export interface RunCollectionDialogProps {
	/**
	 * The collection to run.
	 *
	 * Non-null, because the caller mounts this component only once a folder has
	 * been chosen and unmounts it when the dialog closes. That mount **is** the
	 * reset: the options start at their defaults every time, where a
	 * always-mounted dialog would carry the previous folder's Recursive and
	 * Iterations over silently, and resetting them in an effect would be a
	 * cascading render for something React already models as identity.
	 */
	collection: Collection;
	onOpenChange: (open: boolean) => void;
}

/** Matches the engine's `iterations` bound: a whole number, 1 or more. */
const MIN_ITERATIONS = 1;

/**
 * In the Fixed request count mode the count is passes through the sequence
 * here, not requests, and `LOAD_TEST_MODES` is not reworded for it:
 * `loadTestModeLabel` names stored runs on every other screen.
 */
const SEQUENCE_PROFILE_COPY: ProfilePickerCopy = {
	iterations: {
		label: "Fixed passes",
		description: "Walk the sequence an exact number of times in total, then stop.",
	},
};

/**
 * The `elements` run override (issue #1495). `timers` applies to every
 * collection run, load test or not - `RunContext`'s constructor reads it off
 * the payload the same way regardless of run shape (`run_manager.cpp`), and
 * `timer.pacing`/`timer.think` honour it in the sequential runner exactly as
 * they do under load (issue #1552's reopen). Under load, `"off"` reaches
 * every `timer.*` kind (since #1498's reopen fix), but `fixedMs`/
 * `{minMs, maxMs}` do not yet reach `timer.pacing`/`timer.throughput` there
 * (#1620) - the sequential run this dialog also drives has no such gap, since
 * it has no separate pre-scheduling hook to thread the override through.
 * `scripts` stays load-only: the design send and the sequential run already
 * run every `script.*` element inline, so a choice between inline and
 * deferred has nothing to say until a run is on the event loop. Matches
 * `docs/engine/api-reference.md`'s "elements" block exactly.
 */
const TIMERS_DEFAULT = "asConfigured";
const SCRIPTS_DEFAULT = "asMarked";

const NO_COLUMNS: string[] = [];

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
}: RunCollectionDialogProps) {
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const openTab = useTabsStore((s) => s.openTab);
	const startRun = useStartScenarioRunMutation();

	const [recursive, setRecursive] = useState(false);
	const [iterations, setIterations] = useState("1");
	/*
	 * Whether the user has typed in the Iterations field, which the value alone
	 * cannot say: a deliberately typed `1` and the untouched default read the
	 * same, and picking a file used to clear both. One of those is a count the
	 * user chose, and clearing it turns "run this sequence once" into a full
	 * pass per row - the opposite of what they asked for, silently.
	 *
	 * A ref rather than state: nothing renders from it, and the pre-fill below
	 * resolves asynchronously - a state value captured in that effect's closure
	 * would be the one from mount, and would clear a `1` typed while the file
	 * was still being read.
	 */
	const iterationsTouched = useRef(false);
	const [dataFileError, setDataFileError] = useState<string | null>(null);
	const [loadTest, setLoadTest] = useState(false);
	/**
	 * Whether the bound contract is a gate for this run (issue #720).
	 *
	 * Off by default, the engine's own default and the #628-era decision: a
	 * schema verdict is its own channel, and folding it into the step outcome
	 * would make every undocumented field look like a broken test.
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
	 * Pass/fail budgets (issue #1564), the same disclosure and payload shape
	 * `LoadTestConfigDialog` uses - reused rather than copied (`budgets.ts`),
	 * since a collection run is now judged against them too, load test or not.
	 */
	const [budgets, setBudgets] = useState<BudgetDraft>(emptyBudgetDraft);
	/**
	 * The `custom.<name>.<stat>` rows (issue #1579) - judged for a design-mode
	 * collection run exactly as the six fixed budgets above are (issue #1564):
	 * `execute_scenario_run` folds `summary.custom_metrics` into the same
	 * `RunSummaryInputs` it evaluates thresholds against for every run mode,
	 * load test or not (`scenario_runner.cpp`). Not gated on the switch.
	 */
	const [customBudgets, setCustomBudgets] = useState<CustomBudgetDraft[]>([]);
	const [failRun, setFailRun] = useState(false);
	const [budgetsOpen, setBudgetsOpen] = useState(false);

	/*
	 * The contract this run is measured against, resolved through the chain
	 * rather than read off the collection being run (issue #729).
	 *
	 * Nearest declared ancestor, the documented rule
	 * (`docs/app/variable-resolution.md`) and the one the engine applies at plan
	 * time: running a sub-collection under a declaring parent binds the parent's
	 * rows, so the file to pre-fill and the columns to diff against are the
	 * parent's too. Keyed the way `useSendWithRow` keys its own read - by the
	 * collection that *declared* the contract, since that is the collection a
	 * pick declares for - and falling back to this collection's own id, which
	 * is what the store holds when no contract is in scope at all.
	 *
	 * ...and the file that contract was last run with, pre-filled (issue #599;
	 * through the chain since #729; shared with the load dialog since #1039).
	 *
	 * Still part of the dialog's mount-is-reset contract: the options start at
	 * their defaults every time this component appears, and one of those
	 * defaults is "the file you declared" rather than a value carried over from
	 * a previous open. The hook owns the one-attempt rule, the row cap and the
	 * moved-file note; what stays here is the half that is *this* dialog's -
	 * the iterations coupling below, which is a fact about the engine's default
	 * for a collection run and not about the file.
	 *
	 * `collection` is handed over because the row this dialog was opened with
	 * stands ahead of the query's copy of itself: the walk must find a contract
	 * it declares even on a render where the query has not answered.
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
		// Same rule as a hand-picked file: a pristine `1` becomes "one pass per
		// row", a typed one is the user's. It rides `onPrefill` rather than the
		// hook because it is a fact about the engine's default for a *collection*
		// run - the load dialog shares the pre-fill and must not share this.
		onPrefill: () => {
			if (!iterationsTouched.current) {
				setIterations((current) => (current === "1" ? "" : current));
			}
		},
	});

	const writer = useDataContractWriter(declaringCollectionId);

	/*
	 * The requests this run sends: the collection's own, and with Recursive every
	 * descendant's - including one that declares a contract of its own, because
	 * a run binds one data set to every step it sends whatever each folder
	 * declares. Which is why this is not `collectionsUnderContract`.
	 */
	const { data: collections = [] } = useCollectionsQuery();
	const auditedCollectionIds = useMemo(
		() => (recursive ? collectSubtreeIds(collection.id, collections) : [collection.id]),
		[recursive, collection.id, collections]
	);
	const fileColumns = dataFile?.parsed.columns ?? NO_COLUMNS;
	const { audit } = useColumnAudit(auditedCollectionIds, fileColumns);

	/*
	 * Empty is a meaningful value only with a data file: it means "one pass per
	 * row", which is the engine's own default when `iterations` is absent from
	 * the payload. Without a file there is no row count to fall back to, so an
	 * empty field is simply invalid.
	 */
	const iterationsBlank = iterations.trim() === "";
	const explicitIterations = iterationsBlank ? undefined : Number(iterations);
	const iterationsValid =
		explicitIterations === undefined
			? !!dataFile
			: Number.isInteger(explicitIterations) && explicitIterations >= MIN_ITERATIONS;

	/*
	 * A load run is shaped by its profile, not by the design-mode `iterations`
	 * above (which stops applying to it - Fixed passes has a pass count of its
	 * own). Refused here rather than sent and refused engine-side, and against
	 * the Settings ceilings, which the engine does not know: the user can see
	 * what is wrong while the field still has focus.
	 */
	const profileError = scenarioProfileError(profile, limits);

	const budgetsError = budgetError(budgets) ?? customBudgetsError(customBudgets);

	const canRun = loadTest
		? !profileError && !dataFileError && !budgetsError
		: iterationsValid && !dataFileError && !budgetsError;

	/*
	 * The chosen file against the contract in scope (issue #599), and against
	 * the requests this run sends (issue #2050). Warnings, never blockers: a
	 * column a request references and the file lacks fails loudly engine-side
	 * at bind time, and a file that carries extra columns is simply a file with
	 * extra columns. What they buy is hearing about it here rather than at
	 * iteration 1. The contract diff is for a pre-filled file that drifted on
	 * disk; once a pick's declare lands it is empty by construction, and the
	 * requests are what is left to compare against.
	 */
	const fileWarnings = dataFile
		? [
				...describeDataSchemaDiff(contract?.columns ?? [], dataFile.parsed.columns),
				...describeUnboundReferences(audit.undeclared),
			]
		: [];

	/*
	 * A pick declares the contract from the picked file (issue #2050), for the
	 * collection whose contract this run binds against; Remove clears it, through
	 * the picker's `onRemove` below, since a file the picker refuses also arrives
	 * here as `null` and must leave the contract alone. The pre-fill never comes
	 * through here, so reopening the dialog writes nothing. A declare that fails
	 * does not touch the selection: the run still sends the previewed rows, and
	 * picking again is the retry.
	 *
	 * Picking a file also clears the *pristine* `1`, so the field shows what the
	 * run will do (one pass per row) instead of quietly contradicting the preview
	 * above it. A count the user typed is theirs and is left alone - including a
	 * typed `1`, which is why this reads the touched flag and not the value.
	 */
	const handleSelectDataFile = (next: SelectedDataFile | null) => {
		setDataFile(next);
		if (next) {
			// A file the user picks by hand replaces whatever was pre-filled, so
			// the note about a file that could not be re-read has nothing left to
			// say.
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
		const thresholds = buildThresholds(budgets, failRun, customBudgets);
		// Top-level, matching where the engine reads it
		// (`validate_elements_run_override` looks at the run payload directly,
		// not inside `scenario`) - and, unlike `mode`/`concurrency`/`duration`
		// below, not gated by `loadTest`: `timers` is honoured by the
		// sequential runner too. Omitted per-field at the engine's own
		// defaults, the same "absent already means what the user asked for"
		// rule `failOnSchemaError` follows below.
		const elementsOverride = {
			...(timersOverride !== TIMERS_DEFAULT ? { timers: timersOverride } : {}),
			...(loadTest && scriptsOverride !== SCRIPTS_DEFAULT
				? { scripts: scriptsOverride }
				: {}),
		};
		const loadFields = loadTest ? scenarioLoadFields(profile) : null;
		startRun.mutate(
			{
				/*
				 * The presence of `mode` is what makes this a load run - the
				 * engine reads exactly that, so a design-mode payload keeps its
				 * meaning by carrying no mode at all rather than by carrying a
				 * flag that says "not a load run".
				 *
				 * `iterations` here is the top-level total of passes (Fixed passes);
				 * the design-mode count rides inside `scenario` below, and only
				 * when the switch is off.
				 */
				...loadFields,
				...(Object.keys(elementsOverride).length > 0 ? { elements: elementsOverride } : {}),
				scenario: {
					source: "collection",
					collectionId: collection.id,
					recursive,
					// Omitted, not sent as the row count: the engine resolves the
					// default, and a client that computed its own would be a
					// second copy of a rule only one side can enforce.
					// A load run shapes itself from the profile (Fixed passes sends
					// its own top-level total), so this count is design-mode only.
					...(!loadTest && explicitIterations !== undefined
						? { iterations: explicitIterations }
						: {}),
					// The parsed rows themselves - the same array the preview
					// showed, never a re-parse - and which file they came from, by
					// name and content hash, never path (#2051), and how it was
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
				// Sent only when the user asked for the gate. The engine's
				// default is off, so absent already says what a `false` would,
				// and the run snapshot then carries the key exactly when the
				// flag changed what "failed" means in the report.
				//
				// Never on a load run: only the design-mode runner demotes a
				// step on a schema failure (the load executor validates once the
				// run has drained), so a load payload carrying it would promise
				// a gate nothing applies.
				...(!loadTest && failOnSchemaError ? { failOnSchemaError: true } : {}),
				// Same two rules as the key above: omitted when off, and never on a
				// load run, whose executor does not read it.
				...(!loadTest && stopOnError ? { stopOnError: true } : {}),
				// Top-level like `elements` and `failOnSchemaError` above, and on
				// the same "absent already says what the user asked for" rule:
				// `buildThresholds` returns `undefined` with nothing declared,
				// which leaves a run that opened this dialog and touched nothing
				// measured but not judged, exactly as before this issue (#1564).
				...(thresholds ? { thresholds } : {}),
			},
			{
				onSuccess: ({ runId }) => {
					// Attach before the tab opens: the stream is replayable from
					// offset 0, so nothing is missed either way, and the tab finds
					// the store already pointed at this run.
					//
					// Which stream, though, is the whole difference between the
					// two executors. A design-mode run emits one `step` event per
					// step execution and no metric ticks; a load run emits ticks
					// at 10 Hz and no steps. Attaching the wrong listener is not a
					// degraded view, it is a permanently empty one - so the live
					// surface follows the executor: the dashboard for a load run,
					// the runner tab for a sequence.
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
			<DialogContent className="sm:max-w-xl">
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
								<Label className="text-xs">Load profile</Label>
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
								isStreamingRequest={false}
								iterationsLabel="Passes through the sequence"
							/>

							<p className="rounded-md border border-border bg-panel px-3 py-2 text-label leading-relaxed text-muted-foreground">
								{summarise(profile, profileError !== null, "sequence")}
							</p>

							{profileError && (
								<Callout severity="blocking" title="Load test">
									{profileError}
								</Callout>
							)}

							<div className="flex items-center justify-between gap-4">
								<Label className="leading-snug">
									Scripts
									<span className="block text-xs font-normal text-muted-foreground">
										As marked runs a script inline only where its own element
										says to; the other two override every script this run.
									</span>
								</Label>
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

					{/* Not gated by Load test, unlike Scripts above: the sequential
					    runner honours `elements.timers` exactly as the load
					    executor does (issue #1552's reopen), so a design-mode run
					    can silence or override its timers too. */}
					<div className="flex items-center justify-between gap-4">
						<Label className="leading-snug">
							Timers
							<span className="block text-xs font-normal text-muted-foreground">
								As configured, or off for this run.
							</span>
						</Label>
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
					 * Pass/fail budgets (issue #1564) - the disclosure itself is
					 * not gated by `loadTest`, unlike Scripts above: the engine
					 * now judges a design-mode collection run against the six
					 * fixed budgets exactly as it already judges a load run, so
					 * those apply to both. The custom rows inside it are the
					 * exception and carry their own gate; see there.
					 * Same card treatment as `LoadTestConfigDialog`'s own
					 * disclosure, for the reason that one gives: a section that
					 * revealed loose fields on the dialog background would read
					 * as unrelated to what disclosed them.
					 */}
					<DisclosureCard
						open={budgetsOpen}
						onOpenChange={setBudgetsOpen}
						title="Pass/fail budgets"
						summary={summariseBudgets(budgets, customBudgets)}
					>
						<p className="text-label leading-relaxed text-muted-foreground">
							{BUDGETS_EXPLAINER}
						</p>
						{BUDGET_FIELDS.map((field) => (
							<NumberField
								key={field.key}
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
						))}

						{/*
						 * Custom metric budgets - not gated by `loadTest`,
						 * same as the six fixed budgets above and for the same
						 * reason: `custom.<name>.<stat>` is judged for a
						 * design-mode collection run exactly as it is for a
						 * load run (`execute_scenario_run`, #1564's own
						 * every-run-mode rule extends to #1500's custom
						 * metrics too).
						 */}
						<div className="space-y-1.5">
							<Label className="text-xs">
								Custom metric budgets
								<span className="ml-1 font-normal text-muted-foreground">
									(optional)
								</span>
							</Label>
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
					<Button onClick={handleRun} disabled={!canRun || startRun.isPending}>
						{startRun.isPending ? (
							<Loader2 className="size-icon animate-spin" />
						) : (
							<Play className="size-icon" data-icon-motion={ICON_MOTION.scale} />
						)}
						Run
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

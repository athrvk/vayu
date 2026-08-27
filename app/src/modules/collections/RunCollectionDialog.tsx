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
 * *is* the folder: the sequence is `requests.order` (and, with Recursive,
 * descendant collections by `collections.order`, depth-first, each subfolder's
 * subtree ahead of its parent's own requests), which is the order the sidebar
 * already shows - top to bottom, subfolders above requests at every depth. There
 * is no step list to author here, and inventing one would be a second source of
 * truth for an ordering the tree already owns.
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
 * cursor every virtual user shares, wrapping for as long as the duration lasts
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
 * Only the three closed-loop modes exist for a scenario. `constant_rps` is a
 * `400` engine-side - an open-loop arrival rate over a multi-step sequence is an
 * arrival-rate executor, which Vayu does not implement - so it is not offered.
 */

import { useRef, useState } from "react";
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
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { useStartScenarioRunMutation } from "@/queries";
import { useDashboardStore, useSessionStore, useTabsStore } from "@/stores";
import { loadTestService, scenarioRunService } from "@/services";
import { describeDataSchemaDiff } from "@/services/data-files";
import { useDeclaredDataFile } from "@/hooks/useDeclaredDataFile";
import type { Collection } from "@/types";
import DataFilePicker, { type SelectedDataFile } from "./DataFilePicker";

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
 * The virtual-user count a load run starts from, and the wall-clock length.
 *
 * Modest on purpose: a sequence multiplies its own step count by the VU count,
 * so a default borrowed from the single-request dialog would aim a folder's
 * worth of requests at a target the user has not yet decided to load.
 */
const DEFAULT_VIRTUAL_USERS = "10";
const DEFAULT_DURATION_SECONDS = "30";

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
	const [virtualUsers, setVirtualUsers] = useState(DEFAULT_VIRTUAL_USERS);
	const [durationSeconds, setDurationSeconds] = useState(DEFAULT_DURATION_SECONDS);

	/*
	 * The contract this run is measured against, resolved through the chain
	 * rather than read off the collection being run (issue #729).
	 *
	 * Nearest declared ancestor, the documented rule
	 * (`docs/app/variable-resolution.md`) and the one the engine applies at plan
	 * time: running a sub-collection under a declaring parent binds the parent's
	 * rows, so the file to pre-fill and the columns to diff against are the
	 * parent's too. Keyed the way `useSendWithRow` keys its own read - by the
	 * collection that *declared* the contract, since that is whose Data tab the
	 * file was picked in - and falling back to this collection's own id, which
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
	 * A load run is bounded by wall-clock, not by passes, so `iterations` above
	 * stops applying to it - the sequence repeats until the duration is up.
	 * Both of these are refused here rather than sent and refused engine-side:
	 * the user can see what is wrong while the field still has focus.
	 */
	const virtualUserCount = Number(virtualUsers);
	const virtualUsersValid =
		Number.isInteger(virtualUserCount) && virtualUserCount >= 1 && virtualUserCount <= 100000;
	const durationValue = Number(durationSeconds);
	const durationValid = Number.isFinite(durationValue) && durationValue > 0;

	const canRun = loadTest
		? virtualUsersValid && durationValid && !dataFileError
		: iterationsValid && !dataFileError;

	/*
	 * The chosen file against the contract the collection declares (issue #599).
	 * A mismatch is a warning and never blocks: a missing column fails loudly
	 * engine-side at bind time, and a file that carries extra columns is simply
	 * a file with extra columns. What it buys is hearing about it here rather
	 * than at iteration 1.
	 */
	const schemaDiff = dataFile
		? describeDataSchemaDiff(contract?.columns ?? [], dataFile.parsed.columns)
		: [];

	/*
	 * Picking a file clears the *pristine* `1`, so the field shows what the run
	 * will do (one pass per row) instead of quietly contradicting the preview
	 * above it. A count the user typed is theirs and is left alone - including a
	 * typed `1`, which is why this reads the touched flag and not the value.
	 */
	const handleSelectDataFile = (next: SelectedDataFile | null) => {
		setDataFile(next);
		// A file the user picks by hand replaces whatever was pre-filled, so the
		// note about a file that could not be re-read has nothing left to say.
		if (next) dismissNote();
		if (next && !iterationsTouched.current && iterations === "1") setIterations("");
		if (!next && iterationsBlank) setIterations("1");
	};

	const handleRun = () => {
		if (!canRun) return;
		startRun.mutate(
			{
				/*
				 * The presence of `mode` is what makes this a load run - the
				 * engine reads exactly that, so a design-mode payload keeps its
				 * meaning by carrying no mode at all rather than by carrying a
				 * flag that says "not a load run".
				 *
				 * `constant_concurrency` and nothing else for now: a ramp is a
				 * second pair of fields for a shape nobody has asked for yet,
				 * and `iterations` mode is what the design-mode path already
				 * expresses more directly.
				 */
				...(loadTest
					? {
							mode: "constant_concurrency" as const,
							concurrency: virtualUserCount,
							duration: `${durationSeconds.trim()}s`,
						}
					: {}),
				scenario: {
					source: "collection",
					collectionId: collection.id,
					recursive,
					// Omitted, not sent as the row count: the engine resolves the
					// default, and a client that computed its own would be a
					// second copy of a rule only one side can enforce.
					// A load run repeats until its duration is up, so the pass
					// count has nothing to say about it.
					...(!loadTest && explicitIterations !== undefined
						? { iterations: explicitIterations }
						: {}),
					// The parsed rows themselves - the same array the preview
					// showed, never a re-parse.
					...(dataFile ? { data: dataFile.parsed.rows } : {}),
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
					if (loadTest) {
						useDashboardStore.getState().startRun(runId, {
							mode: "constant_concurrency",
							concurrency: virtualUserCount,
							duration: `${durationSeconds.trim()}s`,
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
					<DialogDescription>
						Every request in this collection runs in order, once per iteration.
						Variables and cookies carry from one step to the next.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-4 py-2">
					<div className="flex items-center justify-between gap-4">
						<Label htmlFor="run-collection-recursive" className="leading-snug">
							Include sub-folders
							<span className="block text-xs font-normal text-muted-foreground">
								Descend into nested collections. Each sub-folder runs before this
								folder&apos;s own requests, top to bottom as the sidebar shows them.
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
								independently, with its own cookies and its own data row, for the
								duration. Scripts do not run.
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
							<div className="flex items-center justify-between gap-4">
								<Label htmlFor="run-collection-vus" className="leading-snug">
									Virtual users
									<span className="block text-xs font-normal text-muted-foreground">
										How many walk the sequence at once. The only concurrency
										knob - in-flight requests are bounded by it.
									</span>
								</Label>
								<Input
									id="run-collection-vus"
									type="number"
									min={1}
									step={1}
									value={virtualUsers}
									onChange={(e) => setVirtualUsers(e.target.value)}
									className="w-24 shrink-0"
									aria-invalid={!virtualUsersValid}
								/>
							</div>

							<div className="flex items-center justify-between gap-4">
								<Label htmlFor="run-collection-duration" className="leading-snug">
									Duration
									<span className="block text-xs font-normal text-muted-foreground">
										Seconds. The sequence repeats until the time is up.
									</span>
								</Label>
								<Input
									id="run-collection-duration"
									type="number"
									min={1}
									step={1}
									value={durationSeconds}
									onChange={(e) => setDurationSeconds(e.target.value)}
									className="w-24 shrink-0"
									aria-invalid={!durationValid}
								/>
							</div>

							{(!virtualUsersValid || !durationValid) && (
								<Callout severity="blocking" title="Load test">
									{!virtualUsersValid
										? "Virtual users must be a whole number of 1 or more."
										: "Duration must be greater than zero seconds."}
								</Callout>
							)}
						</>
					)}

					{/* A load run is bounded by its duration, so the pass count has
					    nothing to say about it and is hidden rather than shown
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
									className="w-24 shrink-0"
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

					{/* A file that could not be re-read is a warning, not a blocker -
					    the run is startable without one, and picking the file again
					    is the whole remedy. */}
					{prefillNote && (
						<Callout severity="warning" title="The remembered data file">
							{prefillNote}
						</Callout>
					)}

					<DataFilePicker
						selected={dataFile}
						onSelect={handleSelectDataFile}
						error={dataFileError}
						onError={setDataFileError}
						iterations={explicitIterations}
						loadTest={loadTest}
						additionalWarnings={schemaDiff}
						disabled={startRun.isPending}
					/>

					{error && (
						<Callout severity="blocking" title="Could not start the run">
							{error instanceof Error ? error.message : "The engine refused it."}
						</Callout>
					)}
				</DialogBody>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={startRun.isPending}
					>
						Cancel
					</Button>
					<Button onClick={handleRun} disabled={!canRun || startRun.isPending}>
						{startRun.isPending ? (
							<Loader2 className="w-4 h-4 mr-2 animate-spin" />
						) : (
							<Play className="w-4 h-4 mr-2" />
						)}
						Run
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

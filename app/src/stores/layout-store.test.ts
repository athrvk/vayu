/**
 * @vitest-environment jsdom
 *
 * zustand's `persist` needs a storage backend to attach `.persist` to the
 * store at all, so `.persist.getOptions()` is undefined without a DOM.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useLayoutStore, resolveResponseArrangement } from "./layout-store";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	CONTEXT_BAR_DEFAULT_COLLAPSED,
	DEFAULT_REQUEST_SPLIT_RATIO,
	PANEL_MIN_WIDTH,
	PANEL_MAX_WIDTH,
	DEFAULT_DRAWER_WIDTH,
	DEFAULT_GRAPHQL_VARIABLES_SIZE,
	GRAPHQL_VARIABLES_MAX_SIZE,
	GRAPHQL_VARIABLES_MIN_SIZE,
	DEFAULT_SCRIPT_EDITOR_HEIGHT,
	REQUEST_SPLIT_RATIO_MAX,
	REQUEST_SPLIT_RATIO_MIN,
	SCRIPT_EDITOR_MIN_HEIGHT,
	SCRIPT_EDITOR_MAX_HEIGHT,
} from "@/constants/layout";

/**
 * The drawer used to store a width per view (history 320, the rest 260), so
 * visiting History widened the drawer and shifted the main content 60px. Width
 * is now shared across views, which means existing users carry a v2 blob that
 * has to be collapsed without silently discarding whatever they had resized to.
 */
describe("layout-store drawer width", () => {
	beforeEach(() => {
		useLayoutStore.setState({ drawerWidth: DEFAULT_DRAWER_WIDTH });
	});

	it("uses one width for every view", () => {
		useLayoutStore.getState().setDrawerWidth(300);
		const { drawerWidth, setDrawerView } = useLayoutStore.getState();
		expect(drawerWidth).toBe(300);

		// switching view must not change the width - that was the shift
		setDrawerView("history");
		expect(useLayoutStore.getState().drawerWidth).toBe(300);
		setDrawerView("settings");
		expect(useLayoutStore.getState().drawerWidth).toBe(300);
	});

	it("clamps to the panel bounds", () => {
		const { setDrawerWidth } = useLayoutStore.getState();
		setDrawerWidth(50);
		expect(useLayoutStore.getState().drawerWidth).toBe(PANEL_MIN_WIDTH);
		setDrawerWidth(9999);
		expect(useLayoutStore.getState().drawerWidth).toBe(PANEL_MAX_WIDTH);
	});

	/*
	 * The context bar shares the drawer's bounds and its clamp, and had no test
	 * for either: deleting the clamp let `setContextBarWidth(Infinity)` through
	 * `partialize` into localStorage, where it comes back as a panel wider than
	 * the window on the next launch.
	 */
	it("clamps the context bar to the same panel bounds", () => {
		const { setContextBarWidth } = useLayoutStore.getState();
		setContextBarWidth(50);
		expect(useLayoutStore.getState().contextBarWidth).toBe(PANEL_MIN_WIDTH);
		setContextBarWidth(Infinity);
		expect(useLayoutStore.getState().contextBarWidth).toBe(PANEL_MAX_WIDTH);
	});

	describe("v2 -> v3 migration", () => {
		// zustand exposes the configured migrate through persist options
		const migrate = (
			useLayoutStore.persist.getOptions() as unknown as {
				migrate: (s: unknown, v: number) => Record<string, unknown>;
			}
		).migrate;

		it("keeps the width the user had set, not the old history default", () => {
			const migrated = migrate(
				{
					drawerWidths: { collections: 300, history: 320, variables: 260, settings: 260 },
					requestSplitRatio: 0.5,
				},
				2
			);
			expect(migrated.drawerWidth).toBe(300);
			expect(migrated.drawerWidths).toBeUndefined();
		});

		it("falls back to the default when no per-view widths were stored", () => {
			const migrated = migrate({ requestSplitRatio: 0.5 }, 2);
			expect(migrated.drawerWidth).toBe(DEFAULT_DRAWER_WIDTH);
		});

		it("still resets a skewed split ratio from v1", () => {
			// Through the v6 branch too: the reset lands on the Beside ratio,
			// which is the one the old single ratio became.
			const migrated = migrate({ requestSplitRatio: 0.97 }, 1);
			expect(migrated.requestSplitRatioBeside).toBe(0.5);
			expect(migrated.requestSplitRatio).toBeUndefined();
		});
	});

	it("persists under the documented key", () => {
		expect(STORAGE_KEYS.LAYOUT_STORE).toBe("vayu.layout");
	});
});

/**
 * Context-bar sections are collapsed by exception: the store holds the ids the
 * user closed, and anything not listed is open.
 *
 * Storing the closed ones rather than the open ones is what makes a section
 * added in a later release ship expanded for existing users instead of
 * invisible - a blob written before it existed cannot name it.
 */
describe("layout-store context-bar sections", () => {
	beforeEach(() => {
		useLayoutStore.setState({ contextBarCollapsedSections: [] });
	});

	it("starts every section expanded but the ones that ship collapsed", () => {
		// The initial state, not the state this file's `beforeEach` installs:
		// asserting the latter would pass with any default at all.
		expect(useLayoutStore.getInitialState().contextBarCollapsedSections).toEqual([
			...CONTEXT_BAR_DEFAULT_COLLAPSED,
		]);
	});

	it("ships `code` collapsed, and nothing else", () => {
		// Named rather than derived from the constant: the list is a deliberate
		// exception to "a section ships expanded" (an expanded Code section
		// composes over the network on mount), and growing it should be a
		// decision someone makes here, not a constant quietly gaining an entry.
		expect([...CONTEXT_BAR_DEFAULT_COLLAPSED]).toEqual(["code"]);
	});

	it("toggles one section without touching the others", () => {
		const { toggleContextBarSection } = useLayoutStore.getState();

		toggleContextBarSection("code");
		toggleContextBarSection("cookies");
		expect(useLayoutStore.getState().contextBarCollapsedSections).toEqual(["code", "cookies"]);

		toggleContextBarSection("code");
		expect(useLayoutStore.getState().contextBarCollapsedSections).toEqual(["cookies"]);
	});

	it("survives a restart, which a Set would not", () => {
		useLayoutStore.getState().toggleContextBarSection("code");

		// `persist` serializes with JSON: a Set writes as `{}` and reads back as
		// one, so every collapse would last exactly until the next launch. Reading
		// what actually reached storage is the only assertion that catches that -
		// the in-memory state looks right either way.
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.LAYOUT_STORE) ?? "{}");
		expect(stored.state.contextBarCollapsedSections).toEqual(["code"]);
	});

	/*
	 * The default and the migration are two halves of one change and neither
	 * works alone. `persist` merges a *missing key* onto the initial state, so a
	 * user who has ever collapsed anything carries an array that would outvote a
	 * new default silently - which is exactly the failure these cases pin.
	 */
	describe("v3 -> v4 migration", () => {
		const migrate = (
			useLayoutStore.persist.getOptions() as unknown as {
				migrate: (s: unknown, v: number) => Record<string, unknown>;
			}
		).migrate;

		it("collapses `code` in a blob that predates the default", () => {
			const migrated = migrate({ contextBarCollapsedSections: ["cookies"] }, 3);
			expect(migrated.contextBarCollapsedSections).toEqual(["cookies", "code"]);
		});

		it("collapses `code` in a blob that had never collapsed anything", () => {
			// The case the initial-state default cannot reach: the key is present
			// and empty, so `persist` has nothing to merge in.
			const migrated = migrate({ contextBarCollapsedSections: [] }, 3);
			expect(migrated.contextBarCollapsedSections).toEqual(["code"]);
		});

		it("does not list `code` twice for a user who had already collapsed it", () => {
			const migrated = migrate({ contextBarCollapsedSections: ["code"] }, 3);
			expect(migrated.contextBarCollapsedSections).toEqual(["code"]);
		});

		it("prunes the retired `environment` id", () => {
			const migrated = migrate({ contextBarCollapsedSections: ["environment", "auth"] }, 3);
			expect(migrated.contextBarCollapsedSections).not.toContain("environment");
			expect(migrated.contextBarCollapsedSections).toEqual(["auth", "code"]);
		});

		it("survives a collapse list that is not a list", () => {
			// localStorage is a text file a user can edit and a bad release can
			// corrupt. A migration that throws here takes every layout preference
			// down with it, so the guard is `Array.isArray`, not a cast.
			for (const junk of ["code", 7, null]) {
				const migrated = migrate(
					{ contextBarCollapsedSections: junk as unknown as string[] },
					3
				);
				expect(migrated.contextBarCollapsedSections).toEqual(["code"]);
			}
		});

		it("survives a blob with no collapse list at all", () => {
			// Every field here is optional in a hand-edited or truncated blob, and
			// a migration that throws takes the whole store down to its defaults.
			const migrated = migrate({}, 3);
			expect(migrated.contextBarCollapsedSections).toEqual(["code"]);
		});

		it("leaves a v4 blob alone, so an explicit expand is not undone", () => {
			// A user who opens Code has removed it from the list. Re-running the
			// v4 branch on every launch would put it back on every launch, which
			// is the difference between a default and a policy.
			const migrated = migrate({ contextBarCollapsedSections: [] }, 4);
			expect(migrated.contextBarCollapsedSections).toEqual([]);
		});
	});
});

/**
 * The GraphQL Variables pane's height, which is a preference and not a schema
 * fact - so it lives here rather than in the in-memory `explorer-store`.
 */
describe("layout-store graphql variables pane", () => {
	beforeEach(() => {
		useLayoutStore.setState({
			graphqlVariablesCollapsed: false,
			graphqlVariablesSize: DEFAULT_GRAPHQL_VARIABLES_SIZE,
		});
	});

	it("opens at the size the pane shipped with", () => {
		expect(useLayoutStore.getState().graphqlVariablesCollapsed).toBe(false);
		expect(useLayoutStore.getState().graphqlVariablesSize).toBe(DEFAULT_GRAPHQL_VARIABLES_SIZE);
	});

	it("clamps a recorded size to the bounds the panel will accept", () => {
		const { setGraphqlVariablesSize } = useLayoutStore.getState();

		// A size read off a panel mid-collapse is below the floor; stored raw it
		// comes back as a height the panel refuses and the pane opens to
		// whatever the library decides instead.
		setGraphqlVariablesSize(2);
		expect(useLayoutStore.getState().graphqlVariablesSize).toBe(GRAPHQL_VARIABLES_MIN_SIZE);

		setGraphqlVariablesSize(99);
		expect(useLayoutStore.getState().graphqlVariablesSize).toBe(GRAPHQL_VARIABLES_MAX_SIZE);

		setGraphqlVariablesSize(48);
		expect(useLayoutStore.getState().graphqlVariablesSize).toBe(48);
	});

	it("survives a restart, both halves", () => {
		useLayoutStore.getState().setGraphqlVariablesCollapsed(true);
		useLayoutStore.getState().setGraphqlVariablesSize(52);

		const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.LAYOUT_STORE) ?? "{}");
		// Mutation check: drop either key from `partialize` and the collapse the
		// user chose lasts exactly until the next launch.
		expect(stored.state.graphqlVariablesCollapsed).toBe(true);
		expect(stored.state.graphqlVariablesSize).toBe(52);
	});
});
/**
 * The Add-element picker's "Recently used" group (issue #1604) - the last
 * five kinds added, most recent first.
 */
describe("layout-store recent element kinds", () => {
	beforeEach(() => {
		useLayoutStore.setState({ recentElementKinds: [] });
	});

	it("starts empty", () => {
		expect(useLayoutStore.getInitialState().recentElementKinds).toEqual([]);
	});

	it("puts the newest kind first", () => {
		const { addRecentElementKind } = useLayoutStore.getState();

		addRecentElementKind("extract.json");
		addRecentElementKind("assert.status");

		expect(useLayoutStore.getState().recentElementKinds).toEqual([
			"assert.status",
			"extract.json",
		]);
	});

	it("moves a repeated kind to the front instead of duplicating it", () => {
		const { addRecentElementKind } = useLayoutStore.getState();

		addRecentElementKind("extract.json");
		addRecentElementKind("assert.status");
		addRecentElementKind("extract.json");

		expect(useLayoutStore.getState().recentElementKinds).toEqual([
			"extract.json",
			"assert.status",
		]);
	});

	it("caps the list at five, dropping the oldest", () => {
		const { addRecentElementKind } = useLayoutStore.getState();

		for (const kind of ["k1", "k2", "k3", "k4", "k5", "k6"]) {
			addRecentElementKind(kind);
		}

		expect(useLayoutStore.getState().recentElementKinds).toEqual([
			"k6",
			"k5",
			"k4",
			"k3",
			"k2",
		]);
	});

	it("survives a restart", () => {
		useLayoutStore.getState().addRecentElementKind("extract.json");

		// Mutation check: drop `recentElementKinds` from `partialize` and the
		// picker's "Recently used" group is empty on every fresh launch.
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.LAYOUT_STORE) ?? "{}");
		expect(stored.state.recentElementKinds).toEqual(["extract.json"]);
	});
});

/**
 * A `script.pre` / `script.post` element's own editor height (issue #1643
 * part 2). Used to be one `scriptEditorHeight` for every script row, so
 * dragging any one row's resize handle silently resized every other one too.
 */
describe("layout-store script editor heights", () => {
	beforeEach(() => {
		useLayoutStore.setState({
			scriptEditorHeights: {},
			scriptEditorHeightDefault: DEFAULT_SCRIPT_EDITOR_HEIGHT,
		});
	});

	it("starts with an empty map and the documented default", () => {
		expect(useLayoutStore.getInitialState().scriptEditorHeights).toEqual({});
		expect(useLayoutStore.getInitialState().scriptEditorHeightDefault).toBe(
			DEFAULT_SCRIPT_EDITOR_HEIGHT
		);
	});

	it("records a height under its own id and updates the shared default", () => {
		useLayoutStore.getState().setScriptEditorHeight("el_1", 300);

		expect(useLayoutStore.getState().scriptEditorHeights).toEqual({ el_1: 300 });
		expect(useLayoutStore.getState().scriptEditorHeightDefault).toBe(300);
	});

	it("leaves another id's entry untouched", () => {
		const { setScriptEditorHeight } = useLayoutStore.getState();
		setScriptEditorHeight("el_1", 300);
		setScriptEditorHeight("el_2", 500);

		expect(useLayoutStore.getState().scriptEditorHeights).toEqual({ el_1: 300, el_2: 500 });
		// The default is whichever was set most recently, across every row.
		expect(useLayoutStore.getState().scriptEditorHeightDefault).toBe(500);
	});

	it("clamps to the editor's bounds", () => {
		const { setScriptEditorHeight } = useLayoutStore.getState();

		setScriptEditorHeight("el_1", 10);
		expect(useLayoutStore.getState().scriptEditorHeights.el_1).toBe(SCRIPT_EDITOR_MIN_HEIGHT);

		setScriptEditorHeight("el_1", 99999);
		expect(useLayoutStore.getState().scriptEditorHeights.el_1).toBe(SCRIPT_EDITOR_MAX_HEIGHT);
	});

	/*
	 * "Least recently set" is insertion order: re-setting an id moves it to the
	 * end, so it is spared the next time the cap evicts the oldest entry. Ids
	 * are `el_0` .. `el_200`, not `"0"` .. `"200"` - integer-like string keys
	 * sort numerically first in JS regardless of insertion order, which would
	 * make this pass for the wrong reason.
	 */
	it("caps at 200 entries, evicting the oldest that was never re-set", () => {
		const { setScriptEditorHeight } = useLayoutStore.getState();

		for (let i = 0; i < 200; i++) setScriptEditorHeight(`el_${i}`, 200);
		expect(Object.keys(useLayoutStore.getState().scriptEditorHeights)).toHaveLength(200);

		setScriptEditorHeight("el_200", 200);

		const heights = useLayoutStore.getState().scriptEditorHeights;
		expect(Object.keys(heights)).toHaveLength(200);
		expect(heights.el_0).toBeUndefined();
		expect(heights.el_1).toBe(200);
		expect(heights.el_200).toBe(200);
	});

	it("re-setting an id moves it to the end, sparing it from the next eviction", () => {
		const { setScriptEditorHeight } = useLayoutStore.getState();

		for (let i = 0; i < 200; i++) setScriptEditorHeight(`el_${i}`, 200);
		setScriptEditorHeight("el_0", 250); // moves el_0 to the end
		setScriptEditorHeight("el_200", 200); // now evicts el_1, not el_0

		const heights = useLayoutStore.getState().scriptEditorHeights;
		expect(heights.el_0).toBe(250);
		expect(heights.el_1).toBeUndefined();
	});

	describe("copyScriptEditorHeight (duplicate, issue #1608)", () => {
		it("copies the source's own height onto the new id, leaving the default alone", () => {
			const { setScriptEditorHeight, copyScriptEditorHeight } = useLayoutStore.getState();
			setScriptEditorHeight("el_1", 300);
			setScriptEditorHeight("el_2", 500); // default is now 500

			copyScriptEditorHeight("el_1", "el_1_copy");

			expect(useLayoutStore.getState().scriptEditorHeights.el_1_copy).toBe(300);
			expect(useLayoutStore.getState().scriptEditorHeightDefault).toBe(500);
		});

		it("is a no-op when the source has no entry of its own", () => {
			useLayoutStore.getState().copyScriptEditorHeight("el_never_dragged", "el_copy");

			expect(useLayoutStore.getState().scriptEditorHeights.el_copy).toBeUndefined();
		});
	});

	it("survives a restart, both keys", () => {
		useLayoutStore.getState().setScriptEditorHeight("el_1", 300);

		// Mutation check: drop either key from `partialize` and a per-row height
		// (or the shared default a fresh row starts from) lasts exactly until
		// the next launch.
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.LAYOUT_STORE) ?? "{}");
		expect(stored.state.scriptEditorHeights).toEqual({ el_1: 300 });
		expect(stored.state.scriptEditorHeightDefault).toBe(300);
	});

	describe("v4 -> v5 migration", () => {
		const migrate = (
			useLayoutStore.persist.getOptions() as unknown as {
				migrate: (s: unknown, v: number) => Record<string, unknown>;
			}
		).migrate;

		it("carries a v4 blob's single height forward as the shared default", () => {
			const migrated = migrate({ scriptEditorHeight: 300 }, 4);
			expect(migrated.scriptEditorHeightDefault).toBe(300);
			expect(migrated.scriptEditorHeights).toEqual({});
			expect(migrated.scriptEditorHeight).toBeUndefined();
		});

		it("clamps a stale value that predates today's bounds", () => {
			const migrated = migrate({ scriptEditorHeight: 5 }, 4);
			expect(migrated.scriptEditorHeightDefault).toBe(SCRIPT_EDITOR_MIN_HEIGHT);
		});

		it("falls back to the documented default when the blob has no old key at all", () => {
			const migrated = migrate({}, 4);
			expect(migrated.scriptEditorHeightDefault).toBe(DEFAULT_SCRIPT_EDITOR_HEIGHT);
			expect(migrated.scriptEditorHeights).toEqual({});
		});

		it("survives a blob where the old key is not a number", () => {
			const migrated = migrate({ scriptEditorHeight: "tall" }, 4);
			expect(migrated.scriptEditorHeightDefault).toBe(DEFAULT_SCRIPT_EDITOR_HEIGHT);
		});

		it("leaves a v5 blob alone", () => {
			// Re-running the v4 branch on every launch would silently reset a
			// per-row map back to empty on every launch, which is the difference
			// between a default and a policy.
			const migrated = migrate(
				{ scriptEditorHeights: { el_1: 400 }, scriptEditorHeightDefault: 400 },
				5
			);
			expect(migrated.scriptEditorHeights).toEqual({ el_1: 400 });
			expect(migrated.scriptEditorHeightDefault).toBe(400);
		});
	});
});

/**
 * Where the response sits (issue #1711): Beside, Below, or Auto, with one split
 * ratio per arrangement so a flip does not undo the drag before it.
 */
describe("layout-store response position", () => {
	beforeEach(() => {
		useLayoutStore.setState({
			responsePosition: "beside",
			autoResponseArrangement: "beside",
			requestSplitRatioBeside: DEFAULT_REQUEST_SPLIT_RATIO,
			requestSplitRatioBelow: DEFAULT_REQUEST_SPLIT_RATIO,
		});
	});

	it("ships Beside, with both ratios even", () => {
		// The initial state, not what `beforeEach` installs: Beside is what every
		// existing user has and what the other tools default to, so a default
		// that drifted to Auto would re-arrange the builder under all of them.
		const initial = useLayoutStore.getInitialState();
		expect(initial.responsePosition).toBe("beside");
		expect(initial.requestSplitRatioBeside).toBe(DEFAULT_REQUEST_SPLIT_RATIO);
		expect(initial.requestSplitRatioBelow).toBe(DEFAULT_REQUEST_SPLIT_RATIO);
	});

	it("toggles beside -> below -> beside", () => {
		const { toggleResponsePosition } = useLayoutStore.getState();
		toggleResponsePosition();
		expect(useLayoutStore.getState().responsePosition).toBe("below");
		toggleResponsePosition();
		expect(useLayoutStore.getState().responsePosition).toBe("beside");
	});

	it("from auto, writes the opposite of what auto currently resolves to", () => {
		// The user chose, so Auto is over: the result is an explicit
		// arrangement, never `auto` again, and it is the one they are not
		// looking at.
		useLayoutStore.setState({ responsePosition: "auto", autoResponseArrangement: "below" });
		useLayoutStore.getState().toggleResponsePosition();
		expect(useLayoutStore.getState().responsePosition).toBe("beside");

		useLayoutStore.setState({ responsePosition: "auto", autoResponseArrangement: "beside" });
		useLayoutStore.getState().toggleResponsePosition();
		expect(useLayoutStore.getState().responsePosition).toBe("below");
	});

	it("resolves the arrangement from the setting, or from auto's pick", () => {
		expect(
			resolveResponseArrangement({
				responsePosition: "below",
				autoResponseArrangement: "beside",
			})
		).toBe("below");
		expect(
			resolveResponseArrangement({
				responsePosition: "auto",
				autoResponseArrangement: "below",
			})
		).toBe("below");
		expect(
			resolveResponseArrangement({
				responsePosition: "auto",
				autoResponseArrangement: "beside",
			})
		).toBe("beside");
	});

	it("keeps one ratio per arrangement, each clamped", () => {
		const { setRequestSplitRatio } = useLayoutStore.getState();
		setRequestSplitRatio("beside", 0.3);
		setRequestSplitRatio("below", 0.7);
		expect(useLayoutStore.getState().requestSplitRatioBeside).toBe(0.3);
		expect(useLayoutStore.getState().requestSplitRatioBelow).toBe(0.7);

		setRequestSplitRatio("beside", 0.05);
		setRequestSplitRatio("below", 0.99);
		expect(useLayoutStore.getState().requestSplitRatioBeside).toBe(REQUEST_SPLIT_RATIO_MIN);
		expect(useLayoutStore.getState().requestSplitRatioBelow).toBe(REQUEST_SPLIT_RATIO_MAX);
	});

	it("survives a restart - the setting and both ratios, but not auto's pick", () => {
		useLayoutStore.getState().setResponsePosition("below");
		useLayoutStore.getState().setRequestSplitRatio("beside", 0.3);
		useLayoutStore.getState().setRequestSplitRatio("below", 0.6);
		useLayoutStore.getState().setAutoResponseArrangement("below");

		// Mutation check: drop any of the three from `partialize` and the choice
		// lasts exactly until the next launch. The fourth is derived from a
		// width that does not survive a relaunch, so persisting it would flash
		// a stale arrangement on the first frame.
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.LAYOUT_STORE) ?? "{}");
		expect(stored.state.responsePosition).toBe("below");
		expect(stored.state.requestSplitRatioBeside).toBe(0.3);
		expect(stored.state.requestSplitRatioBelow).toBe(0.6);
		expect(stored.state.autoResponseArrangement).toBeUndefined();
	});

	describe("v5 -> v6 migration", () => {
		const migrate = (
			useLayoutStore.persist.getOptions() as unknown as {
				migrate: (s: unknown, v: number) => Record<string, unknown>;
			}
		).migrate;

		it("carries the one old ratio forward as the Beside ratio, Below even, position Beside", () => {
			// Mutation check: drop the v5 branch in `migrate` and a 0.33.0 user's
			// split comes back at 50/50 with the old key still in the blob.
			const migrated = migrate({ requestSplitRatio: 0.3 }, 5);
			expect(migrated.requestSplitRatioBeside).toBe(0.3);
			expect(migrated.requestSplitRatioBelow).toBe(0.5);
			expect(migrated.responsePosition).toBe("beside");
			expect(migrated.requestSplitRatio).toBeUndefined();
		});

		it("clamps a stale ratio and falls back when the blob has none", () => {
			expect(migrate({ requestSplitRatio: 0.95 }, 5).requestSplitRatioBeside).toBe(
				REQUEST_SPLIT_RATIO_MAX
			);
			expect(migrate({}, 5).requestSplitRatioBeside).toBe(DEFAULT_REQUEST_SPLIT_RATIO);
			expect(migrate({ requestSplitRatio: "wide" }, 5).requestSplitRatioBeside).toBe(
				DEFAULT_REQUEST_SPLIT_RATIO
			);
		});

		it("leaves a v6 blob alone, so a chosen Below is not undone on launch", () => {
			const migrated = migrate(
				{
					responsePosition: "below",
					requestSplitRatioBeside: 0.4,
					requestSplitRatioBelow: 0.6,
				},
				6
			);
			expect(migrated.responsePosition).toBe("below");
			expect(migrated.requestSplitRatioBeside).toBe(0.4);
			expect(migrated.requestSplitRatioBelow).toBe(0.6);
		});
	});
});

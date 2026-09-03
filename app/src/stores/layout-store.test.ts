/**
 * @vitest-environment jsdom
 *
 * zustand's `persist` needs a storage backend to attach `.persist` to the
 * store at all, so `.persist.getOptions()` is undefined without a DOM.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useLayoutStore } from "./layout-store";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	CONTEXT_BAR_DEFAULT_COLLAPSED,
	PANEL_MIN_WIDTH,
	PANEL_MAX_WIDTH,
	DEFAULT_DRAWER_WIDTH,
	DEFAULT_GRAPHQL_VARIABLES_SIZE,
	GRAPHQL_VARIABLES_MAX_SIZE,
	GRAPHQL_VARIABLES_MIN_SIZE,
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
			const migrated = migrate({ requestSplitRatio: 0.97 }, 1);
			expect(migrated.requestSplitRatio).toBe(0.5);
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
			const migrated = migrate(
				{ contextBarCollapsedSections: ["environment", "auth"] },
				3
			);
			expect(migrated.contextBarCollapsedSections).not.toContain("environment");
			expect(migrated.contextBarCollapsedSections).toEqual(["auth", "code"]);
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

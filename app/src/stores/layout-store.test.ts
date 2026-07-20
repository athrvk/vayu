import { describe, it, expect, beforeEach } from "vitest";
import { useLayoutStore } from "./layout-store";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, DEFAULT_DRAWER_WIDTH } from "@/constants/layout";

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

		// switching view must not change the width — that was the shift
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

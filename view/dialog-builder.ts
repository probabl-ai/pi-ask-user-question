import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type Editor, Spacer, truncateToWidth } from "@earendil-works/pi-tui";
import { DEFAULT_COLLAPSE_KEY, formatKeySpecForDisplay } from "../config.js";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { PreviewPaneProps } from "./components/preview/preview-pane.js";
import type { TabBar } from "./components/tab-bar.js";
import type { StatefulView } from "./stateful-view.js";
import type { TabComponents } from "./tab-components.js";
import {
	QuestionTabStrategy,
	SubmitTabStrategy,
	type HeadingLines,
	type TabContentStrategy,
} from "./tab-content-strategy.js";

export const HINT_PART_ENTER = "Enter to select";
export const HINT_PART_NAV = "↑/↓ to navigate";
export const HINT_PART_NEW_LINE = "Shift+Enter for newline";
export const HINT_PART_CLEAR = "Ctrl+U to clear";
export const HINT_PART_TOGGLE = "Space to toggle";
export const HINT_PART_NOTES = "n to add notes";
export const HINT_PART_TAB = "Tab to switch questions";
export const HINT_PART_CANCEL = "Esc to cancel";
/**
 * Collapse/expand hint copy is templated on `KEY_PLACEHOLDER` because the
 * shortcut is configurable (`collapseKey`) and `rpiv-i18n`'s `tr` has no
 * interpolation — locale entries carry the same `{key}` placeholder and call
 * sites `.replace()` it with `formatKeySpecForDisplay(collapseKey)` after
 * lookup, so per-locale word order is preserved.
 */
export const KEY_PLACEHOLDER = "{key}";
export const HINT_PART_COLLAPSE_TEMPLATE = `${KEY_PLACEHOLDER} to collapse`;
export const HINT_PART_EXPAND_TEMPLATE = `${KEY_PLACEHOLDER} to expand`;
/** Default-key (`Ctrl+]`) rendering of the collapse template, for tests and default-config assertions. */
export const HINT_PART_COLLAPSE = HINT_PART_COLLAPSE_TEMPLATE.replace(
	KEY_PLACEHOLDER,
	formatKeySpecForDisplay(DEFAULT_COLLAPSE_KEY),
);
/**
 * `HINT_SINGLE` / `HINT_MULTI` are the resting core hint for NON-multiSelect
 * question tabs only: `buildHintText` drops `NOTES` while the notes editor is
 * open (`state.notesVisible`) or the "Type something." row is capturing text
 * (`state.inputMode`), and on multiSelect tabs it interleaves `TOGGLE` between
 * `NAV` and `NOTES`, so neither composite is a substring there — assert on
 * `HINT_PART_*` constants in those states instead. The collapse affordance is
 * appended AFTER cancel by `buildHintText` so the resting core stays a contiguous
 * prefix substring of the rendered line. On narrow terminals the collapse tail
 * clips with `…` (`OneLineClippedText`); the core is preserved.
 */
export const HINT_SINGLE = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_NOTES, HINT_PART_CANCEL].join(" · ");
export const HINT_MULTI = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_NOTES, HINT_PART_TAB, HINT_PART_CANCEL].join(
	" · ",
);
/**
 * Template for the single-line footer shown by `QuestionnaireSession` when
 * `state.collapsed === true`. Bypasses `buildHintText`; the session replaces
 * `KEY_PLACEHOLDER` with the configured key's display form.
 */
export const COLLAPSED_HINT_TEMPLATE = [HINT_PART_EXPAND_TEMPLATE, HINT_PART_CANCEL].join(" · ");
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";

const OVERFLOW_UP = "↑";
const OVERFLOW_DOWN = "↓";
const OVERFLOW_BOTH = "↕";

/**
 * Scrollable rows a sticky heading always leaves on screen: one option row plus
 * both overflow indicators. Below this the dialog gives up the sticky band and
 * scrolls the heading too (see `DialogView.render`).
 */
export const MIN_STICKY_BODY_ROWS = 3;

/** No-overflow path: append the residual spacer rows after the footer. */
function renderFitsTerminal(natural: string[], spacerRows: number): string[] {
	return spacerRows > 0 ? [...natural, ...Array<string>(spacerRows).fill("")] : natural;
}

/** Terminal too small for any middle content — show just chrome, hard-clamped to termRows. */
function renderChromeOnly(natural: string[], topFixed: number, bottomFixed: number, termRows: number): string[] {
	const chromeOnly = [...natural.slice(0, topFixed), ...natural.slice(natural.length - bottomFixed)];
	return chromeOnly.length > termRows ? chromeOnly.slice(0, termRows) : chromeOnly;
}

/**
 * Shrink the sticky heading to `budget` rows. The badge and the spacers go first;
 * only when the question statement alone does not fit is its tail cut with `…` — a
 * clipped question never looks complete.
 */
function clipHeading(heading: HeadingLines, budget: number, width: number): string[] {
	if (heading.lines.length <= budget) return heading.lines;
	if (heading.keep.length <= budget) return heading.keep;
	const kept = heading.keep.slice(0, budget);
	kept[kept.length - 1] = truncateToWidth(kept[kept.length - 1] as string, Math.max(1, width - 1), "…", false);
	return kept;
}

/** Scroll window start, centered on the focused option; top-anchored when there is no interactive focus. */
function computeScrollStart(
	bodyRange: [number, number] | undefined,
	offsetAboveBody: number,
	availableMiddle: number,
	middleRows: number,
): number {
	if (!bodyRange) return 0;
	const focusedRowInMiddle = offsetAboveBody + bodyRange[0];
	const focusedHeight = bodyRange[1] - bodyRange[0];
	// Center the focused item vertically in the available middle space.
	const idealStart = focusedRowInMiddle - Math.floor(Math.max(0, availableMiddle - focusedHeight) / 2);
	return Math.max(0, Math.min(idealStart, middleRows - availableMiddle));
}

/** Mark the scroll window edges with overflow arrows; combined ↕ on a single-row middle. */
function decorateOverflow(scrollableMiddle: string[], hasUp: boolean, hasDown: boolean, theme: Theme): void {
	if (hasUp && hasDown && scrollableMiddle.length === 1) {
		// Single-row middle: combined ↕ avoids the prior collision where ↓ overwrote ↑.
		scrollableMiddle[0] = theme.fg("dim", OVERFLOW_BOTH);
		return;
	}
	if (hasUp && scrollableMiddle.length > 0) {
		scrollableMiddle[0] = theme.fg("dim", OVERFLOW_UP);
	}
	if (hasDown && scrollableMiddle.length > 0) {
		scrollableMiddle[scrollableMiddle.length - 1] = theme.fg("dim", OVERFLOW_DOWN);
	}
}

/**
 * Slice the scroll window out of the scrollable middle. With room to spare the two
 * indicators take their own rows (so an arrow never covers the focused option, whose
 * highlight row usually sits at the window edge on small terminals); a 1-2 row window
 * keeps the legacy overwrite behaviour, where the combined ↕ handles the collision.
 */
function windowMiddle(
	scrollable: string[],
	bodyRange: [number, number] | undefined,
	rows: number,
	theme: Theme,
): string[] {
	if (rows < MIN_STICKY_BODY_ROWS) {
		const start = computeScrollStart(bodyRange, 0, rows, scrollable.length);
		const window = scrollable.slice(start, start + rows);
		decorateOverflow(window, start > 0, start + rows < scrollable.length, theme);
		return window;
	}
	const contentRows = rows - 2;
	const start = computeScrollStart(bodyRange, 0, contentRows, scrollable.length);
	const hasUp = start > 0;
	const hasDown = start + contentRows < scrollable.length;
	return [
		hasUp ? theme.fg("dim", OVERFLOW_UP) : "",
		...scrollable.slice(start, start + contentRows),
		hasDown ? theme.fg("dim", OVERFLOW_DOWN) : "",
	];
}

export type DialogState = QuestionnaireState;

/** Per-tick projection of dialog state. Written by the adapter; read by the strategy thunk. */
export interface DialogProps {
	state: DialogState;
	activePreviewPane: StatefulView<PreviewPaneProps>;
}

/** Construction-time config for `DialogView`. Frozen after construction. */
export interface DialogConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	tabBar: TabBar | undefined;
	notesInput: Editor;
	isMulti: boolean;
	tabsByIndex: ReadonlyArray<TabComponents>;
	/** Optional so single-question mode and non-submit tests can omit it; SubmitTabStrategy falls back to Spacer rows. */
	submitPicker?: Component;
	/** Worst-case body height across all tabs/options. Determines the stable overall dialog footprint. */
	getBodyHeight: (width: number) => number;
	/** Body height of the CURRENTLY active tab/option. The chrome subtracts this from `getBodyHeight` to absorb the residual OUTSIDE the bordered region. */
	getCurrentBodyHeight: (width: number) => number;
	/**
	 * Row budget getter, read at render time: the terminal height minus the rows the
	 * input dock leaves to the transcript and footer (see `dialogRowBudget`).
	 */
	getTerminalRows: () => number;
	/**
	 * Resolved collapse/expand key spec (`resolveCollapseKey` output: `"ctrl+]"`,
	 * `"alt+o"`, or `"off"`). Construction-time config, NOT canonical state —
	 * `QuestionnaireRuntime.collapseKey` must never reach view setProps consumers.
	 * The footer hint interpolates it, and drops the collapse part when `"off"`.
	 */
	collapseKey: string;
}

/**
 * The 7th renderable, promoted from a structural literal to a named class so
 * all view-layer components share one explicit `implements StatefulView<P>`
 * contract. `setProps(DialogProps)` writes the live cell read by the
 * strategy thunk during `render()`. `liveProps.activePreviewPane` is a
 * resolved pane reference threaded by the adapter per tick — the dialog
 * itself does not derive it.
 */
export class DialogView implements StatefulView<DialogProps> {
	private liveProps: DialogProps;
	private readonly config: DialogConfig;
	private readonly questionStrategy: TabContentStrategy;
	private readonly submitStrategy: TabContentStrategy | undefined;
	private readonly maxFooterRowCount: number;

	constructor(config: DialogConfig, initialProps: DialogProps) {
		this.config = config;
		this.liveProps = initialProps;
		this.questionStrategy = new QuestionTabStrategy({
			theme: config.theme,
			questions: config.questions,
			getPreviewPane: () => this.liveProps.activePreviewPane,
			tabsByIndex: config.tabsByIndex,
			notesInput: config.notesInput,
			isMulti: config.isMulti,
			getCurrentBodyHeight: config.getCurrentBodyHeight,
			collapseKey: config.collapseKey,
		});
		this.submitStrategy = config.isMulti
			? new SubmitTabStrategy({
					theme: config.theme,
					questions: config.questions,
					submitPicker: config.submitPicker,
					notesInput: config.notesInput,
				})
			: undefined;
		this.maxFooterRowCount = Math.max(this.questionStrategy.footerRowCount, this.submitStrategy?.footerRowCount ?? 0);
	}

	setProps(props: DialogProps): void {
		this.liveProps = props;
	}

	handleInput(_data: string): void {}

	// Invalidation is driven by `QuestionnairePropsAdapter.invalidate()`, which
	// owns the full set of renderables (binding registries + extras like
	// `notesInput`). DialogView has no cached layout of its own.
	invalidate(): void {}

	render(width: number): string[] {
		const state = this.liveProps.state;
		const onSubmit = this.config.isMulti && state.currentTab === this.config.questions.length;
		const strategy = onSubmit && this.submitStrategy ? this.submitStrategy : this.questionStrategy;

		// Fixed region sizes (deterministic from structure).
		// TabBar.render() returns [tabLine, ""] — always 2 rows.
		const topFixed = 1 + (this.config.isMulti && this.config.tabBar ? 2 : 0) + 1;
		const bottomFixed = 1 + strategy.footerRowCount;

		// Heading rows are spliced in as text rather than mounted as container children so
		// the same rows can also serve as the sticky band on a short terminal (below).
		const heading = strategy.headingLines(width, state);
		const chrome = this.buildContainerFromStrategy(strategy).render(width);
		const natural = [...chrome.slice(0, topFixed), ...heading.lines, ...chrome.slice(topFixed)];

		const middleRows = natural.length - topFixed - bottomFixed;

		// Residual spacer: equalizes total height across tabs (only needed when no overflow).
		const spacerRows = Math.max(
			0,
			this.config.getBodyHeight(width) +
				this.maxFooterRowCount -
				strategy.bodyHeight(width, state) -
				strategy.footerRowCount,
		);

		const termRows = this.config.getTerminalRows();

		if (natural.length + spacerRows <= termRows) {
			return renderFitsTerminal(natural, spacerRows);
		}

		// OVERFLOW — apply 3-region partition with scroll-to-focus.
		const availableMiddle = Math.max(0, termRows - topFixed - bottomFixed);
		if (availableMiddle === 0) {
			return renderChromeOnly(natural, topFixed, bottomFixed, termRows);
		}

		// STICKY HEADING — the question keeps `availableMiddle - MIN_STICKY_BODY_ROWS`
		// rows while the option list scrolls under it, so the user never loses the
		// question they are answering. A terminal too short even for that falls back to
		// scrolling the whole middle, heading included.
		const headingBudget = availableMiddle - MIN_STICKY_BODY_ROWS;
		if (headingBudget >= 1) {
			const band = clipHeading(heading, headingBudget, width);
			const scrollable = natural.slice(topFixed + heading.lines.length, natural.length - bottomFixed);
			const windowRows = Math.min(availableMiddle - band.length, scrollable.length);
			const scrollWindow = windowMiddle(
				scrollable,
				strategy.focusedItemRowRange(width, state),
				windowRows,
				this.config.theme,
			);
			const result = [
				...natural.slice(0, topFixed),
				...band,
				...scrollWindow,
				...natural.slice(natural.length - bottomFixed),
			];
			if (result.length > termRows) return result.slice(0, termRows);
			return renderFitsTerminal(result, termRows - result.length);
		}

		// FALLBACK — no room for a sticky heading: scroll the whole middle, heading included.
		const scrollStart = computeScrollStart(
			strategy.focusedItemRowRange(width, state),
			heading.lines.length,
			availableMiddle,
			middleRows,
		);
		const scrollableMiddle = natural.slice(topFixed + scrollStart, topFixed + scrollStart + availableMiddle);
		decorateOverflow(
			scrollableMiddle,
			scrollStart > 0,
			scrollStart + availableMiddle < middleRows,
			this.config.theme,
		);

		const result = [
			...natural.slice(0, topFixed),
			...scrollableMiddle,
			...natural.slice(natural.length - bottomFixed),
		];
		// Safety: never exceed terminal rows (covers the availableMiddle === 0 case
		// where topFixed + bottomFixed > termRows).
		if (result.length > termRows) return result.slice(0, termRows);
		// The equalized height (natural + spacer) overflows, but this tab's own body
		// may be shorter than the window: pad like `renderFitsTerminal` so every tab
		// renders exactly `termRows` and the dialog height stays stable across tabs.
		return renderFitsTerminal(result, termRows - result.length);
	}

	private buildContainerFromStrategy(strategy: TabContentStrategy): Container {
		const { theme, isMulti, tabBar } = this.config;
		const state = this.liveProps.state;
		const container = new Container();
		const border = () => new DynamicBorder((s) => theme.fg("accent", s));

		container.addChild(border());
		if (isMulti && tabBar) container.addChild(tabBar);
		container.addChild(new Spacer(1));

		container.addChild(strategy.bodyComponent(state));
		container.addChild(new Spacer(1));
		for (const c of strategy.midRows(state)) container.addChild(c);

		container.addChild(border());
		for (const c of strategy.footerRows(state)) container.addChild(c);

		// BodyResidualSpacer moved out of Container — handled in render().
		return container;
	}
}

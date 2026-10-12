import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeTheme } from "../test/utils/index.js";
import { describe, expect, it, vi } from "vitest";
import type { QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { dialogRowBudget } from "./build-questionnaire.js";
import { QuestionnaireSession } from "./questionnaire-session.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "<ENTER>";
const ESC = "\x1b";
const CTRL_G = "\x07";
const CTRL_U = "\x15";
const SHIFT_ENTER = "\x1b\r";
const TAB = "\t";
const CTRL_RIGHT_BRACKET = "\x1d";
// Kitty CSI-u for ctrl+] (codepoint 93, modifier 5 = 1 + ctrl) with event types.
const KITTY_CTRL_RIGHT_BRACKET_PRESS = "\x1b[93;5u";
const KITTY_CTRL_RIGHT_BRACKET_REPEAT = "\x1b[93;5:2u";

const params: QuestionParams = {
	questions: [
		{
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		},
	],
};

function itemsFor(value: QuestionParams): WrappingSelectItem[][] {
	return value.questions.map((question) => [
		...question.options.map((option) => ({
			kind: "option" as const,
			label: option.label,
			description: option.description,
		})),
		{ kind: "other" as const, label: "Type something." },
	]);
}

const keybindings = {
	matches(data: string, name: string): boolean {
		switch (name) {
			case "tui.select.up":
				return data === UP;
			case "tui.select.down":
				return data === DOWN;
			case "tui.select.confirm":
				return data === ENTER;
			case "tui.input.newLine":
				return data === SHIFT_ENTER;
			case "tui.editor.cursorUp":
				return data === UP;
			case "tui.editor.cursorDown":
				return data === DOWN;
			case "tui.select.cancel":
				return data === ESC;
			case "tui.editor.deleteToLineStart":
				return data === CTRL_U;
			case "app.editor.external":
				return data === CTRL_G;
			default:
				return false;
		}
	},
};

interface SessionTestOptions {
	params?: QuestionParams;
	itemsByTab?: WrappingSelectItem[][];
	editInput?: (value: string) => Promise<string | undefined>;
	keybindings?: typeof keybindings;
	tui?: unknown;
	collapseKey?: string;
}

function makeSession(options: SessionTestOptions = {}) {
	const sessionParams = options.params ?? params;
	const done = vi.fn<(result: QuestionnaireResult) => void>();
	const session = new QuestionnaireSession({
		tui: (options.tui ?? { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() }) as unknown as TUI,
		theme: makeTheme() as unknown as Theme,
		params: sessionParams,
		itemsByTab: options.itemsByTab ?? itemsFor(sessionParams),
		done,
		keybindings: options.keybindings ?? keybindings,
		editInput: options.editInput ?? (async () => undefined),
		collapseKey: options.collapseKey ?? "off",
	});
	return { session, done };
}

function focusCustomAnswer(session: QuestionnaireSession): void {
	session.dispatch(DOWN);
	session.dispatch(DOWN);
}

describe("QuestionnaireSession — custom-answer drafts", () => {
	it("preserves a draft while browsing options and restores it on return", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("draft answer");
		session.dispatch(UP);
		const browsingView = session.component.render(120).join("\n");
		expect(browsingView).toContain("draft answer");
		expect(browsingView).not.toContain("Type something.");
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [
				{
					questionIndex: 0,
					question: "Which?",
					kind: "custom",
					answer: "draft answer",
				},
			],
			cancelled: false,
		});
	});

	it("submits a multiline custom answer composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		const view = session.component.render(120).join("\n");
		expect(view).toContain("first line");
		expect(view).toContain("second line");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("uses vertical arrows within the draft and returns to row navigation at the boundary", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch("!");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first!\nsecond" })],
			cancelled: false,
		});
	});

	it("clears the whole draft with Pi's Ctrl+U line-kill binding", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("discard me");
		session.dispatch(CTRL_U);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: null })],
			cancelled: false,
		});
	});

	it("replaces the inline draft with the external editor result", async () => {
		const editInput = vi.fn(async (value: string) => `${value} + edited`);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);
		await Promise.resolve();
		await Promise.resolve();
		expect(editInput).toHaveBeenCalledWith("draft");
		session.dispatch(ENTER);

		expect(done).toHaveBeenLastCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "draft + edited" })],
			cancelled: false,
		});
	});

	it("keeps input exclusive while the external editor is open", async () => {
		let resolveEditor!: (value: string | undefined) => void;
		const editInput = vi.fn(
			() =>
				new Promise<string | undefined>((resolve) => {
					resolveEditor = resolve;
				}),
		);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);

		session.dispatch(UP);
		session.dispatch("late input");
		resolveEditor("edited");
		await Promise.resolve();
		await Promise.resolve();
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "edited" })],
			cancelled: false,
		});
	});

	it("attaches multiline notes composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		session.dispatch("n");
		session.dispatch("first note");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second note");
		session.dispatch(ENTER);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "option", notes: "first note\nsecond note" })],
			cancelled: false,
		});
	});

	it("commits the typed draft with a remapped tui.input.submit key (#156)", () => {
		// Slack-style config: enter is folded into tui.input.newLine (colliding with
		// the default tui.select.confirm), submit lives on its own key. The submit
		// key must confirm the custom answer instead of falling through to the
		// editor, whose own submit handling would wipe the draft.
		const CTRL_ENTER = "<CTRL_ENTER>";
		const remapped: typeof keybindings = {
			matches(data: string, name: string): boolean {
				if (name === "tui.input.submit") return data === CTRL_ENTER;
				if (name === "tui.input.newLine") return data === ENTER || data === SHIFT_ENTER;
				return keybindings.matches(data, name);
			},
		};
		const { session, done } = makeSession({ keybindings: remapped });
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		session.dispatch(CTRL_ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("a raw Enter byte the router does not match cannot wipe the draft via the editor's own submit (#156)", () => {
		// The session fake matches only the <ENTER> sentinel, so a raw "\r" reaches
		// the headless Editor, whose GLOBAL keybindings still bind tui.input.submit
		// to enter. Without disableSubmit, Editor.submitValue() would reset the
		// buffer and silently destroy the draft.
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("precious draft");
		session.dispatch("\r");
		expect(session.component.render(120).join("\n")).toContain("precious draft");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "precious draft" })],
			cancelled: false,
		});
	});

	it("keeps each question's latest draft isolated through real navigation and tab switches", () => {
		const multiParams: QuestionParams = {
			questions: [
				{ ...params.questions[0]!, question: "First?", header: "First" },
				{ ...params.questions[0]!, question: "Second?", header: "Second" },
			],
		};
		const { session } = makeSession({ params: multiParams });

		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch("-latest");
		session.dispatch(ENTER);

		focusCustomAnswer(session);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch(TAB);
		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("first-latest");

		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("second");
	});
});

describe("QuestionnaireSession — collapse in the input dock", () => {
	it("shrinks to a single hint row on the collapse key and expands on the next press", () => {
		const { session } = makeSession({ collapseKey: "ctrl+]" });
		const expanded = session.component.render(120);
		expect(expanded.length).toBeGreaterThan(1);

		session.dispatch(CTRL_RIGHT_BRACKET);
		const collapsed = session.component.render(120);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("to expand");

		session.dispatch(CTRL_RIGHT_BRACKET);
		expect(session.component.render(120)).toEqual(expanded);
	});

	it("ignores Kitty key repeats so a held collapse key does not flicker", () => {
		const { session } = makeSession({ collapseKey: "ctrl+]" });
		session.dispatch(KITTY_CTRL_RIGHT_BRACKET_PRESS);
		session.dispatch(KITTY_CTRL_RIGHT_BRACKET_REPEAT);
		expect(session.component.render(120)).toHaveLength(1);
	});

	it("never collapses when the shortcut is off", () => {
		const { session } = makeSession();
		session.dispatch(CTRL_RIGHT_BRACKET);
		expect(session.component.render(120).length).toBeGreaterThan(1);
	});
});

describe("QuestionnaireSession — row budget in the input dock", () => {
	it("caps the dialog at its row budget on a short terminal", () => {
		const manyOptions: QuestionParams = {
			questions: [
				{
					question: "Which?",
					header: "Pick",
					options: Array.from({ length: 12 }, (_, i) => ({ label: `Option ${i}`, description: `desc ${i}` })),
				},
			],
		};
		const rows = 20;
		const { session } = makeSession({
			params: manyOptions,
			tui: { terminal: { columns: 120, rows }, requestRender: vi.fn() },
		});
		expect(session.component.render(120).length).toBeLessThanOrEqual(dialogRowBudget(rows));
	});

	it("reserves 8 rows on normal terminals and fewer on small ones", () => {
		// 4 chrome rows (status + footer) + rows/8 transcript rows, clamped to 1..4.
		expect(dialogRowBudget(60)).toBe(52);
		expect(dialogRowBudget(40)).toBe(32);
		expect(dialogRowBudget(24)).toBe(17);
		expect(dialogRowBudget(16)).toBe(10);
		expect(dialogRowBudget(10)).toBe(5);
	});

	it("never budgets fewer than one row", () => {
		expect(dialogRowBudget(3)).toBe(1);
	});
});

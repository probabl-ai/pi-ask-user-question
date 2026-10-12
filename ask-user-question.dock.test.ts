import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockPi } from "./test/utils/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { AskUserQuestionConfig } from "./config.js";

/**
 * Integration tests for the docked questionnaire (#2). The dialog replaces the chat
 * editor through a non-overlay `ctx.ui.custom` call, so Pi's layout shrinks the
 * transcript to the rows above it instead of painting the dialog over the
 * transcript's last rows. Collapse and paging go through the component's own
 * `handleInput`; transcript scrolling stays with the host.
 */

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

const CTRL_RBRACKET = "\x1d"; // GS byte — what legacy terminals send for Ctrl+]
const KITTY_CTRL_RBRACKET_PRESS = "\x1b[93;5u";
const KITTY_CTRL_RBRACKET_REPEAT = "\x1b[93;5:2u";
const ALT_O = "\x1bo"; // ESC-prefixed 'o' — legacy encoding for Alt+O
const PAGE_DOWN = "\x1b[6~";

const keybindings = {
	matches(data: string, name: string): boolean {
		if (name === "tui.select.pageDown") return data === PAGE_DOWN;
		if (name === "tui.select.confirm") return data === "\r";
		return false;
	},
};

const params = {
	questions: [
		{
			question: "Pick one",
			header: "Choice",
			options: [{ label: "Alpha" }, { label: "Beta" }],
		},
	],
};

type SessionComponent = { render(width: number): string[]; handleInput(data: string): void };

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

/**
 * Fake `ctx.ui` mimicking interactive mode: `custom` runs the real factory, then
 * `script` drives the component before resolving. `onTerminalInput` is present so a
 * regression that re-registers raw listeners is observable.
 */
function drive(script: (component: SessionComponent, done: (v: unknown) => void) => void) {
	const onTerminalInput = vi.fn(() => () => {});
	const fakeTui = { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } };
	const custom = vi.fn(
		(
			factory: (
				tui: typeof fakeTui,
				theme: typeof identityTheme,
				kb: typeof keybindings,
				done: (v: unknown) => void,
			) => unknown,
			_options?: unknown,
		) =>
			new Promise((resolve) => {
				const component = factory(fakeTui, identityTheme, keybindings, resolve) as SessionComponent;
				script(component, resolve);
			}),
	);
	const ctx = { hasUI: true, ui: { custom, onTerminalInput, notify: vi.fn() } } as never;
	return { ctx, custom, onTerminalInput };
}

const home = process.env.HOME ?? "";
const configDir = join(home, ".config", "pi-ask-user-question");
const configPath = join(configDir, "config.json");

function writeCollapseKeyConfig(collapseKey: string): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, JSON.stringify({ collapseKey } satisfies AskUserQuestionConfig));
}

afterEach(() => {
	if (existsSync(configPath)) rmSync(configPath);
});

describe("ask_user_question — docked in place of the editor (#2)", () => {
	it("opens as a non-overlay custom component so the transcript is never covered", async () => {
		const tool = register();
		const { ctx, custom } = drive((_c, done) => done({ answers: [], cancelled: true }));
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(custom).toHaveBeenCalledTimes(1);
		const options = custom.mock.calls[0]?.[1] as { overlay?: boolean } | undefined;
		expect(options?.overlay).not.toBe(true);
	});

	it("registers no raw terminal listeners: the host keeps transcript scrolling", async () => {
		const tool = register();
		const { ctx, onTerminalInput } = drive((_c, done) => done({ answers: [], cancelled: true }));
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(onTerminalInput).not.toHaveBeenCalled();
	});

	it("leaves PgUp/PgDn to the dialog's option-list paging", async () => {
		const tool = register();
		const manyOptions = {
			questions: [
				{
					question: "Pick one",
					header: "Choice",
					options: Array.from({ length: 8 }, (_, i) => ({ label: `Option ${i + 1}` })),
				},
			],
		};
		const { ctx } = drive((component) => {
			component.handleInput(PAGE_DOWN);
			component.handleInput("\r");
		});
		const result = (await tool.execute?.(
			"tc",
			manyOptions as never,
			undefined as never,
			undefined as never,
			ctx,
		)) as { details: { answers: Array<{ answer: unknown }> } };
		// PAGE_STEP (5) rows down from the first option.
		expect(result.details.answers[0]?.answer).toBe("Option 6");
	});
});

describe("ask_user_question — collapse in the dock", () => {
	it("collapses to one row and expands again on the default key", async () => {
		const tool = register();
		const { ctx } = drive((component, done) => {
			const expanded = component.render(120);
			expect(expanded.length).toBeGreaterThan(1);
			component.handleInput(CTRL_RBRACKET);
			const collapsed = component.render(120);
			expect(collapsed).toHaveLength(1);
			expect(collapsed[0]).toContain("Ctrl+] to expand");
			component.handleInput(CTRL_RBRACKET);
			expect(component.render(120)).toEqual(expanded);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("toggles once for a Kitty press followed by repeats", async () => {
		const tool = register();
		const { ctx } = drive((component, done) => {
			component.handleInput(KITTY_CTRL_RBRACKET_PRESS);
			component.handleInput(KITTY_CTRL_RBRACKET_REPEAT);
			expect(component.render(120)).toHaveLength(1);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("honours a configured collapseKey and names it in the footer and collapsed row (#176)", async () => {
		writeCollapseKeyConfig("alt+o");
		const tool = register();
		const { ctx } = drive((component, done) => {
			const expanded = component.render(120).join("\n");
			expect(expanded).toContain("Alt+O to collapse");
			expect(expanded).not.toContain("Ctrl+]");
			component.handleInput(CTRL_RBRACKET);
			expect(component.render(120).length).toBeGreaterThan(1);
			component.handleInput(ALT_O);
			const collapsed = component.render(120);
			expect(collapsed).toHaveLength(1);
			expect(collapsed[0]).toContain("Alt+O to expand");
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("keeps collapse disabled when collapseKey is 'off'", async () => {
		writeCollapseKeyConfig("off");
		const tool = register();
		const { ctx } = drive((component, done) => {
			const rendered = component.render(120).join("\n");
			expect(rendered).not.toContain("to collapse");
			expect(rendered).toContain("Esc to cancel");
			component.handleInput(CTRL_RBRACKET);
			expect(component.render(120).length).toBeGreaterThan(1);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});
});

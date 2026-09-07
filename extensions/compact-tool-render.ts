/**
 * Compact Tool Render — 单行折叠 + tidy 风格状态机
 *
 * 用 prototype 级 render 覆盖保证折叠态是真正的“一行”（不经过官方 Box 外壳），
 * 同时搬来 tidy-tools 的设计：
 *   - 整组状态机 + 行级点击 override
 *   - Ctrl+Alt+C / /compact-toggle 一键整组折叠/展开
 *   - fullscreen 下左键点击单个工具块单独展开/收起
 *   - 不再依赖 thinking-block
 *
 * 覆盖工具：bash / read / find / grep / ls
 * edit / write 保持 Pi 官方默认显示。
 *
 * 为什么不用 pi.registerTool 注册同名工具：
 *   1. 注册后会走 ToolExecutionComponent 的默认 Box/Spacer 外壳，折叠态不可能
 *      压缩成一行（那是本扩展的核心诉求）。
 *   2. 会和 minimal-anchor.ts 在加载期产生 bash 同名工具冲突。
 */

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const COMPACT_TOOL_NAMES = new Set(["bash", "read", "find", "grep", "ls"]);
const GROUP_LABEL = "bash/read/find/grep/ls";

// ---------------------------------------------------------------------------
// 状态机：整组基准 + 行级 override（仿 tidy-tools）
// ---------------------------------------------------------------------------

let groupExpanded = false; // false = 默认折叠
let groupRevision = 0;

interface RowExpansionState {
    revision: number;
    override?: boolean;
}

function getRowExpansionState(self: any): RowExpansionState {
    let state = self.rendererState?.compactExpansion as RowExpansionState | undefined;
    if (!state || state.revision !== groupRevision) {
        state = { revision: groupRevision };
        if (!self.rendererState) self.rendererState = {};
        self.rendererState.compactExpansion = state;
    }
    return state;
}

function isToolExpanded(self: any): boolean {
    const rowState = getRowExpansionState(self);
    return rowState.override ?? groupExpanded;
}

function refreshToolRows(ctx: ExtensionContext): void {
    // 强制所有工具行重绘；本扩展自行决定折叠/展开，Pi 全局 expanded 只作刷新触发。
    const globalExpanded = ctx.ui.getToolsExpanded();
    ctx.ui.setToolsExpanded(!globalExpanded);
    ctx.ui.setToolsExpanded(globalExpanded);
}

function toggleCompactTools(ctx: ExtensionContext): void {
    groupExpanded = !groupExpanded;
    groupRevision++;
    refreshToolRows(ctx);
    ctx.ui.notify(
        `compact tools (${GROUP_LABEL}): ${groupExpanded ? "expanded" : "collapsed"}`,
        "info",
    );
}

// ---------------------------------------------------------------------------
// 单行摘要（保留 compact-tool-render 旧版的状态点样式）
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const paint = (code: string, text: string) => `\x1b[${code}m${text}${RESET}`;
const DIM = (s: string) => paint("2", s);
const GREEN = (s: string) => paint("32", s);
const YELLOW = (s: string) => paint("33", s);
const RED = (s: string) => paint("31", s);

function clip(s: string, max = 72): string {
    return truncateToWidth(s.replace(/\s+/g, " ").trim(), max);
}

function lineCount(text: string): number {
    return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function firstLine(s: string): string {
    return s.split("\n")[0]?.trim() ?? "";
}

function getText(result: any): string {
    if (!result?.content) return "";
    return result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text ?? "")
        .join("");
}

function isError(toolName: string, result: any, text: string): boolean {
    if (result?.isError) return true;
    if (toolName === "bash") {
        const m = text.match(/exit code:\s*(\d+)/i);
        if (m && Number(m[1]) !== 0) return true;
    }
    const head = text.trimStart().slice(0, 200).toLowerCase();
    return (
        head.startsWith("error") ||
        head.includes("not found") ||
        head.includes("cannot find") ||
        head.includes("permission denied") ||
        head.includes("access denied")
    );
}

function toolSummary(toolName: string, args: any): string {
    const a = (k: string) => (typeof args?.[k] === "string" ? args[k] : "");
    switch (toolName) {
        case "bash":
            return `bash ${clip(a("command"))}`;
        case "read": {
            const file = String(args?.path ?? "").split("/").pop() ?? "";
            return `read ${clip(file, 60)}`;
        }
        case "find": {
            const pattern = clip(a("pattern"), 30);
            const dir = a("path") || a("directory") || "";
            const dirName = dir.split("/").pop() ?? dir;
            return `find ${pattern} in ${clip(dirName, 40)}`;
        }
        case "grep": {
            const pattern = clip(a("pattern"), 30);
            const dir = a("path") || a("directory") || "";
            const dirName = dir.split("/").pop() ?? dir;
            return `grep ${pattern} in ${clip(dirName, 40)}`;
        }
        case "ls":
            return `ls ${clip(a("path") || ".", 60)}`;
        default:
            return toolName;
    }
}

function compactLine(self: any): string {
    const args = self.args ?? {};
    const result = self.result;
    const name = self.toolName;
    const summary = toolSummary(name, args);
    const text = getText(result);
    const finished = !!result && !self.isPartial;
    const error = finished && isError(name, result, text);

    if (finished) {
        const dot = error ? RED("✗") : GREEN("✓");
        let suffix: string;
        if (error) {
            const first = clip(firstLine(text), 60) || "failed";
            suffix = ` → ${first}`;
        } else {
            const n = lineCount(text);
            suffix = n > 0 ? ` · ${n}L` : " · ok";
        }
        return `${dot} ${summary}${suffix}`;
    }
    if (!self.executionStarted) {
        return `${DIM("○")} ${summary}`;
    }
    if (self.isPartial) {
        const n = lineCount(text);
        return `${YELLOW("●")} ${summary}${n > 0 ? ` · ${n}L` : ""}`;
    }
    return `${GREEN("✓")} ${summary}`;
}

// ---------------------------------------------------------------------------
// 渲染覆盖：折叠时直接输出一行；展开时临时让官方组件认为 expanded=true
// ---------------------------------------------------------------------------

const originalRender = ToolExecutionComponent.prototype.render;

(ToolExecutionComponent.prototype as any).render = function (this: any, width: number): string[] {
    if (COMPACT_TOOL_NAMES.has(this.toolName) && !isToolExpanded(this)) {
        const line = compactLine(this);
        const maxW = Math.max(20, width - 4);
        if (visibleWidth(line) > maxW) {
            return [truncateToWidth(line, maxW)];
        }
        return [line];
    }
    // 展开态：强制官方完整渲染（跳过官方“未展开”预览）。
    if (COMPACT_TOOL_NAMES.has(this.toolName)) {
        const previousExpanded = this.expanded;
        this.expanded = true;
        try {
            return originalRender.call(this, width);
        } finally {
            this.expanded = previousExpanded;
        }
    }
    return originalRender.call(this, width);
};

// ---------------------------------------------------------------------------
// 点击：fullscreen 下左键单击工具行，单独翻转该行
// ---------------------------------------------------------------------------

(ToolExecutionComponent.prototype as any).handleMouse = function (this: any, event: any) {
    if (!COMPACT_TOOL_NAMES.has(this.toolName)) return undefined;
    if (event?.type !== "click" || event?.button !== "left") return undefined;

    const rowState = getRowExpansionState(this);
    rowState.override = !isToolExpanded(this);
    this.invalidate?.();
    this.ui?.requestRender?.();
    return { handled: true };
};

// ---------------------------------------------------------------------------
// Kitty 键盘协议输入桥（只处理 Ctrl+Alt+C）
// ---------------------------------------------------------------------------

const CTRL_CODE_TO_KEY: Record<number, string> = {
    3: "c", // Ctrl+C 的控制字符码
};
const ALT_MODIFIER = 2;
let debugNextTerminalInput = false;

function convertCtrlAltSequence(data: string): string | undefined {
    if (data.length === 2 && data[0] === "\x1b") {
        const key = CTRL_CODE_TO_KEY[data.charCodeAt(1)];
        if (key) return `\x1b[${key.charCodeAt(0)};7u`;
    }
    const match = data.match(/^\x1b\[(\d+);(\d+)(?::(\d+))?u$/);
    if (!match) return undefined;
    const code = Number(match[1]);
    const modifier = Number(match[2]) - 1;
    const key = CTRL_CODE_TO_KEY[code];
    if (!key || (modifier & ALT_MODIFIER) === 0) return undefined;
    const eventSuffix = match[3] ? `:${match[3]}` : "";
    return `\x1b[${key.charCodeAt(0)};7${eventSuffix}u`;
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
    pi.registerCommand("compact-toggle", {
        description: `Toggle collapse/expand for ${GROUP_LABEL}`,
        handler: async (_args, ctx) => toggleCompactTools(ctx),
    });

    pi.registerCommand("compact-key-debug", {
        description: "Show the next raw terminal key sequence",
        handler: async (_args, ctx) => {
            debugNextTerminalInput = true;
            ctx.ui.notify("Press one key to inspect its terminal sequence.", "info");
        },
    });

    pi.registerShortcut("ctrl+alt+c", {
        description: `Toggle ${GROUP_LABEL} expansion`,
        handler: (ctx) => toggleCompactTools(ctx),
    });

    pi.on("session_start", (_event, ctx) => {
        ctx.ui.onTerminalInput((data) => {
            const converted = convertCtrlAltSequence(data);
            if (debugNextTerminalInput) {
                debugNextTerminalInput = false;
                const bytes = [...data].map((char) => char.charCodeAt(0)).join(", ");
                ctx.ui.notify(
                    `raw: ${JSON.stringify(data)} [${bytes}]${converted ? ` → ${JSON.stringify(converted)}` : ""}`,
                    "info",
                );
            }
            return converted ? { data: converted } : undefined;
        });
    });
}

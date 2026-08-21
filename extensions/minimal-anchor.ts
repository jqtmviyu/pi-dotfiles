/**
 * minimal-anchor —— DeepSeek Harness `minimal` preset 的 pi 移植版。
 *（“精确的 RL prompt 与 schema”）：一个句子、两个工具、complete:true，
 * 抑制运行时上下文。
 *
 * Bootstrap（请求 #1）：system 仅为 SPEC_PERSONA；工具为 dsh minimal 的
 * [bash, str_replace_editor]（使用 dsh 的 schema/description；bash 在 pi 自己的
 * shell 后端中运行）；在全新会话中主动发送一条首个用户消息（hi）作为词汇锚点。
 *
 * Promoted（首个 tool_call 或 agent_settled）：bash 重新注册为 pi 的原始定义，
 * 恢复 bootstrap 前的工具快照，persona 保持置前，同时恢复 pi 的全部功能区段
 * （含 <available_skills>；/skill:name 始终有效）。
 * 第一轮（bootstrap hi）本来就是整体替换为纯 persona，因此无需单独移除 skills。
 *
 * 文件位置：~/.pi/agent/extensions/。
 * 该扩展会被全局自动发现。
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
  createBashToolDefinition,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── persona 与种子 ──────────────────────────────────────────────────────────

const SPEC_PERSONA = "You are a helpful software engineer assistant."; // 与原文逐字节一致，包括句号
/** 全新会话主动发送的首条用户消息（词汇锚点）。 */
const SEED_FIRST_MESSAGE = "hi";

// ── bash：dsh 的 schema/description，使用 pi 自己的执行后端 ────────────────

const bashOps = createLocalBashOperations();
let bashIsDshVariant = true; // promote 重新注册 pi 原始 bash 时切换为 false

const BASH_DESCRIPTION = [
  "Run commands in a bash shell",
  '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
  "* You don't have access to the internet via this tool.",
  "* You do have access to a mirror of common linux and python packages via apt and pip.",
  "* State is persistent across command calls and discussions with the user.",
  "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
  "* Please avoid commands that may produce a very large amount of output.",
  "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
].join("\n");

const BASH_PARAMETERS = Type.Object({
  command: Type.String({ description: "The bash command to execute (`bash -c` string domain)." }),
  workdir: Type.Optional(Type.String({ description: "Optional working directory; defaults to the session cwd." })),
}, { additionalProperties: false });

// ── str_replace_editor（dsh minimal 的第二个工具） ──────────────────────────

const MAX_OUTPUT_CHARS = 16000; // dsh minimal 配置
type EditorCommand = "view" | "create" | "str_replace" | "insert" | "undo";

/** path -> 最近一次编辑前的内容（用于 undo）。 */
const editHistory = new Map<string, { content: string; action: string }>();

/** 使用 `cat -n` 风格编号（Anthropic/OpenAI str_replace_editor 格式）。 */
const numbered = (text: string) =>
  text.split("\n").map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join("\n");

const clampOutput = (text: string) =>
  text.length <= MAX_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated to ${MAX_OUTPUT_CHARS} chars)`;

function runEditor(params: {
  command: EditorCommand;
  path: string;
  file_text?: string;
  view_range?: number[];
  old_string?: string;
  new_string?: string;
  insert_line?: number;
}): string {
  const abs = resolve(params.path);
  switch (params.command) {
    case "view": {
      if (!existsSync(abs)) throw new Error(`File or directory not found: ${abs}`);
      if (statSync(abs).isDirectory()) {
        return clampOutput(`Here's the files in directory ${abs}:\n${readdirSync(abs).sort().join("\n")}`);
      }
      const lines = readFileSync(abs, "utf8").split("\n");
      const [start, end] = params.view_range ?? [];
      if (start !== undefined) {
        if (start < 1) throw new Error(`Invalid view_range start ${start}: must be >= 1`);
        if (start > lines.length) throw new Error(`view_range start ${start} exceeds file length ${lines.length} (${abs})`);
        return clampOutput(`Here's the result of running \`cat -n\` on ${abs}:\n${numbered(lines.slice(start - 1, end ?? lines.length).join("\n"))}`);
      }
      return clampOutput(`Here's the result of running \`cat -n\` on ${abs}:\n${numbered(lines.join("\n"))}`);
    }
    case "create": {
      if (existsSync(abs)) throw new Error(`File already exists at: ${abs}. Use str_replace or insert to edit it.`);
      writeFileSync(abs, params.file_text ?? "", "utf8");
      editHistory.set(abs, { content: "", action: "create" });
      return `File created successfully at: ${abs}`;
    }
    case "str_replace": {
      const oldStr = params.old_string;
      if (typeof oldStr !== "string" || oldStr === "") throw new Error("str_replace requires a non-empty old_string");
      const content = readFileSync(abs, "utf8");
      const n = content.split(oldStr).length - 1;
      if (n === 0) throw new Error(`The string to replace was not found in ${abs}.`);
      if (n > 1) throw new Error(`Found ${n} occurrences of the old_string in ${abs}. Please include more context in old_string to make the replacement unique.`);
      editHistory.set(abs, { content, action: "str_replace" });
      writeFileSync(abs, content.replace(oldStr, params.new_string ?? ""), "utf8");
      return `The file ${abs} has been edited.`;
    }
    case "insert": {
      const line = params.insert_line;
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1) throw new Error("insert requires an integer insert_line >= 1");
      const lines = readFileSync(abs, "utf8").split("\n");
      if (line > lines.length) throw new Error(`insert_line ${line} exceeds file length ${lines.length} (${abs}).`);
      editHistory.set(abs, { content: lines.join("\n"), action: "insert" });
      writeFileSync(abs, [...lines.slice(0, line), params.new_string ?? "", ...lines.slice(line)].join("\n"), "utf8");
      return `The file ${abs} has been edited.`;
    }
    case "undo": {
      const prev = editHistory.get(abs);
      if (!prev) throw new Error(`No edit history for ${abs} — nothing to undo.`);
      editHistory.delete(abs);
      writeFileSync(abs, prev.content, "utf8");
      return `The file ${abs} has been edited (undo of ${prev.action}).`;
    }
    default:
      throw new Error(`Unknown command: ${String(params.command)}`);
  }
}

// ── system prompt 处理 ───────────────────────────────────────────────────

const PI_IDENTITY_PREFIX = "You are an expert coding assistant operating inside pi";

/** 只用 persona 替换 pi 的身份段落；保留所有功能区段
 *  （tools、guidelines、docs、<project_context>、<available_skills>、cwd）。
 *  回退方案（自定义 SYSTEM.md）：在前面添加 persona，绝不丢弃任何区段。 */
function applyPersonaSection(baseSystemPrompt: string, persona: string): string {
  let rest = baseSystemPrompt;
  if (baseSystemPrompt.startsWith(PI_IDENTITY_PREFIX)) {
    const idx = baseSystemPrompt.indexOf("\n\nAvailable tools:");
    if (idx !== -1) rest = baseSystemPrompt.slice(idx + 2);
  }
  return `${persona}\n\n${rest}`;
}

// ── 会话级状态 ───────────────────────────────────────────────────────

const TOOLS_ENTRY = "minimal-anchor-tools"; // 持久化的工具快照（可安全应对崩溃/恢复）

interface SessionState {
  promoted: boolean;
  fullTools: string[] | null; // 裁剪为 minimal 工具集之前保存的 pi 默认工具集
}

const sessions = new Map<string, SessionState>();

const stateFor = (ctx: ExtensionContext): SessionState => {
  const id = ctx.sessionManager.getSessionId() ?? "ephemeral";
  let state = sessions.get(id);
  if (!state) sessions.set(id, state = { promoted: false, fullTools: null });
  return state;
};

const hasPromotionSignal = (ctx: ExtensionContext): boolean => {
  // 只有“持久对话”才算 promote 信号：model_change / thinking_level_change 等
  // 元数据条目在全新会话中也会先落盘，不能当作已经完成过 bootstrap。
  try {
    return (ctx.sessionManager.getEntries() ?? []).some((entry) =>
      entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult")
    );
  } catch { return false; }
};

/** promote 后从完整工具集中剔除 bootstrap 专用工具 str_replace_editor。 */
const withoutBootstrapEditor = (tools: string[]): string[] =>
  tools.filter((n) => n !== "str_replace_editor");

const saveFullTools = (pi: ExtensionAPI, tools: string[]): void => {
  try { pi.appendEntry(TOOLS_ENTRY, { tools: withoutBootstrapEditor(tools) }); } catch { /* 内存中的快照仍然可用 */ }
};

const loadFullTools = (ctx: ExtensionContext): string[] | null => {
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === TOOLS_ENTRY) {
        const data = entry.data as { tools?: string[] } | undefined;
        if (Array.isArray(data?.tools) && data.tools.length > 0) return withoutBootstrapEditor(data.tools);
      }
    }
  } catch { /* 没有持久化的快照 */ }
  return null;
};

const cwdOf = (ctx: unknown): string => (ctx as { cwd?: string })?.cwd || process.cwd();

// ── 扩展 ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── dsh minimal 工具对（bash 覆盖 pi 的内置工具：扩展优先） ──
  pi.registerTool({
    name: "bash",
    label: "Bash",
    description: BASH_DESCRIPTION,
    promptSnippet: "Run commands in a bash shell",
    parameters: BASH_PARAMETERS,
    async execute(_toolCallId, params: { command: string; workdir?: string }, signal, _onUpdate, ctx) {
      const cwd = params.workdir || cwdOf(ctx);
      let out = "";
      let code: number | null = null;
      const fail = (msg: string) => { throw new Error(`${out.trim()}${out.trim() ? "\n\n" : ""}${msg}`); };
      try {
        ({ exitCode: code } = await bashOps.exec(params.command, cwd, {
          onData: (d) => { out += d.toString(); },
          signal,
          timeout: undefined, // dsh schema 没有 timeout 参数
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("timeout:")) fail(`Command timed out after ${msg.split(":")[1]} seconds`);
        else if (msg === "aborted") fail("Command aborted");
        else throw err;
      }
      if (code !== 0 && code !== null) fail(`Command exited with code ${code}`);
      return { content: [{ type: "text", text: out.trim() || "(no output)" }] };
    },
  });

  pi.registerTool({
    name: "str_replace_editor",
    label: "Str Replace Editor",
    description:
      "Custom editing tool for viewing, creating and editing files. "
      + "Commands: view (with optional view_range for a line range), create, "
      + "str_replace (unique old_string -> new_string), insert (after "
      + "insert_line), undo (revert the last edit to the file).",
    promptSnippet: "View, create, and edit files with the str_replace_editor",
    parameters: Type.Object({
      command: StringEnum(["view", "create", "str_replace", "insert", "undo"] as const),
      path: Type.String({ description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`." }),
      file_text: Type.Optional(Type.String({ description: "Required parameter of `create` command, with the content of the file to be created." })),
      view_range: Type.Optional(Type.Array(Type.Number(), { description: "Optional parameter of `view` command: [start] or [start, end] 1-based line range." })),
      old_string: Type.Optional(Type.String({ description: "Required parameter of `str_replace` command containing the string in `path` to replace." })),
      new_string: Type.Optional(Type.String({ description: "Required parameter of `str_replace` command containing the new string." })),
      insert_line: Type.Optional(Type.Number({ description: "Required parameter of `insert` command: the `new_string` is inserted after this 1-based line." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      return { content: [{ type: "text", text: runEditor(params as Parameters<typeof runEditor>[0]) }] };
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const state: SessionState = { promoted: hasPromotionSignal(ctx), fullTools: null };
    sessions.set(ctx.sessionManager.getSessionId() ?? "ephemeral", state);
    if (state.promoted) {
      // 在 bootstrap 中途崩溃后恢复：还原 pi 默认工具集
      const saved = loadFullTools(ctx);
      if (saved) {
        state.fullTools = saved;
        try { pi.setActiveTools(saved); } catch { /* 尽力而为 */ }
      }
      return;
    }
    // 全新会话：主动发送首条用户消息（恢复/重新加载时绝不注入）
    if (event.reason === "new" || event.reason === "startup") {
      try { await pi.sendUserMessage(SEED_FIRST_MESSAGE); } catch { /* 未注入种子的会话仍然可以工作 */ }
    }
  });

  // ── promote（首个 tool_call 或首个已结束回合） ─────────────────────
  function promote(ctx: ExtensionContext): void {
    const state = stateFor(ctx);
    if (state.promoted) return;
    state.promoted = true;
    // 使用相同名称重新注册 pi 的原始 bash（在处理器中有效）
    if (bashIsDshVariant) {
      bashIsDshVariant = false;
      try { pi.registerTool(createBashToolDefinition(cwdOf(ctx), {})); } catch { /* 保留 dsh 变体 */ }
    }
    if (state.fullTools?.length) {
      try { pi.setActiveTools(withoutBootstrapEditor(state.fullTools)); } catch { /* 尽力而为 */ }
    }
  }
  pi.on("tool_call", (_event, ctx) => { promote(ctx); });
  pi.on("agent_settled", (_event, ctx) => { promote(ctx); });

  // ── 双阶段 system prompt ─────────────────────────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    const state = stateFor(ctx);
    if (!state.promoted) {
      // 只保存一次 pi 默认工具集，裁剪为 [bash, str_replace_editor]，单独发送 persona
      if (state.fullTools === null) {
        state.fullTools = withoutBootstrapEditor(pi.getActiveTools());
        saveFullTools(pi, state.fullTools);
        try { pi.setActiveTools(["bash", "str_replace_editor"]); } catch { /* 保留当前工具集 */ }
      }
      return { systemPrompt: SPEC_PERSONA };
    }
    return { systemPrompt: applyPersonaSection(event.systemPrompt, SPEC_PERSONA) };
  });
}

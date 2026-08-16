/**
 * flash-router — Flash-optimized task-aware reasoning routing for pi.
 *
 * Ports the Flash-specific findings from `dsh-routing-suite` (router-standard,
 * experiments §B/§K/§L, P8/P10/P11) onto pi's extension model. This is a
 * PERSONA-DOMINATED strategy: for DeepSeek V4 Flash the tool catalog is
 * measured catalog-immune (§B) — the persona decides the trajectory, NOT the
 * tool schema. So this extension does NOT narrow tools; it classifies the
 * first task and injects the matching persona + one-shot guidance.
 *
 * Measured evidence this encodes (routing-suite, official API, n=2-3):
 *
 *  §B  Flash: persona-dominated, catalog-immune, zero transient let-me.
 *  §K  P8 domain scan: react-weak (+4.67) and mixed (+3.00) are the STRONGEST
 *      routing domains on Flash; weak persona lets task content penetrate.
 *  §L  P10 deep-then-converge: deep MUST pair with "then produce" (pure
 *      "think deeply" = 0% convergence trap).
 *  §L  P11 weak persona: "You are a helpful assistant." + classify + recall +
 *      converge anchors lifts single-task completion to 100% (w7, +5.67).
 *  §L  P21 related-task chain: per-message guidance is NEGATIVE in same-file
 *      chains; guidance is injected ONCE for the first real task.
 *
 * Routing model (v0.2.0 router-core, task-aware):
 *   mode 0    -> pure spec  — plan-first, read-first
 *   mode 0.3  -> mixed      — transition band (trap; explicit opt-in only)
 *   mode 1    -> pure react — doer, produce-verify-fix
 *   mode W    -> weak       — internal routing (model decides per task)
 * `classifyTask` reads the first user message: clear keyword evidence picks
 * react(1)/spec(0); ambiguous text returns 'weak'. An explicit override via
 * `dev_router_mode` wins over classification.
 *
 * TWO-PHASE PORT of dsh-anchored-standard (anchored tool bootstrap):
 *
 *   bootstrap (request #1): system prompt = persona ONLY — the exact probe
 *     condition the routing-suite measured (P8-F/P11: system = persona text,
 *     nothing else; context digest, skills, docs pointers all absent).
 *   promoted (request #2+): the persona stays CONSTANT ("keep the Minimal
 *     complete system prompt" — anchored-standard keeps the persona across
 *     phases), while pi's functional sections return unchanged: the
 *     CLAUDE.md/AGENTS.md <project_context> digest, the skills list, and the
 *     Pi documentation pointers (so pi self-questions resolve against the
 *     installed docs/*.md instead of source-code spelunking).
 *
 *   Promotion signal = the first durable `tool_call` OR the first settled
 *   agent turn (promoteOn: 'either' — a text-only first reply cannot trap
 *   the session in bootstrap). Resume/reload derive the phase from persisted
 *   session entries, so a resumed session starts promoted.
 *
 * Implementation notes for pi:
 *  - `before_agent_start` fires once per USER turn; the returned systemPrompt
 *    overrides that run's system prompt.
 *  - pi's persona section is its default identity paragraph ("You are an
 *    expert coding assistant operating inside pi…"), replaced surgically by
 *    applyPersonaSection — never drop the functional sections (§5.6 router
 *    amnesia), never append the persona after pi's identity (P6 position,
 *    A2 identity mixing).
 *  - thinking stays at "max" via settings.json defaultThinkingLevel + the
 *    model's thinkingLevelMap (deepseek: max -> "max").
 *
 * File placement: ~/.pi/agent/extensions/ (global, auto-discovered).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── routing modes (router-core.mjs) ─────────────────────────────────────────

const MODE_SPEC = 0;
const MODE_MIXED = 0.3;
const MODE_REACT = 1;
const MODE_WEAK = "weak" as const;

type Mode = number | "weak";

// ── personas (router-core.mjs, verbatim where Flash-specific) ───────────────

const SPEC_PERSONA = "You are a helpful software engineer assistant.";

const MIXED_PERSONA =
  "You are a helpful software engineer assistant.\n"
  + "Work directly: prefer writing or editing code over describing plans. "
  + "Verify your changes by reading and running them.";

const REACT_PERSONA =
  "You are a hands-on software engineer who delivers working output fast.\n"
  + "Work directly: write or edit code, then verify it by reading and running. "
  + "Keep the loop tight — produce, verify, fix — and do not build test "
  + "harnesses, scaffolding, or ceremony the user did not ask for. "
  + "Finish with a usable deliverable and a short summary.";

/**
 * P11 optimal weak persona for V4 Flash (w7, +5.67, single-task completion
 * 100%). Neutral identity + classify-then-act + recall anchor + anti-runaway
 * + deep-then-produce (P10 convergence anchor).
 */
const WEAK_FLASH_PERSONA =
  "You are a helpful assistant.\n"
  + "Before acting, decide the task type (build or fix) and adopt the matching "
  + "style: build → hands-on production; fix → inspect-and-plan.\n"
  + "Before acting, briefly review what you have already done in this session "
  + "and continue from where you left off; do not repeat completed steps. "
  + "Do not run environment checks (echo, whoami, uname, node --version, date) "
  + "or exhaustive grep/glob scans.\n"
  + "Think deeply first, then produce.";

/** P11 weak persona for non-Flash models (kept for completeness). */
const WEAK_PRO_PERSONA =
  "You are a helpful software engineer assistant.\n"
  + "Before acting, decide the task type (build or fix) and adopt the matching "
  + "style: build → hands-on production; fix → inspect-and-plan.";

/**
 * P10 deep-then-converge: the critical convergence anchor. Deep thinking MUST
 * pair with an explicit "then commit and act" — pure "think deeply" runs to
 * the budget ceiling with 0% convergence.
 */
const DEEP_CONVERGE =
  "\n\nWork in tight produce-verify-fix loops: think, then act, verify by "
  + "reading and running, fix, repeat. Do not spend reasoning on the "
  + "environment or tooling. Produce when your information is complete.";

/** Persona for a mode; weak picks the model-specific internal-routing text. */
function personaFor(mode: Mode, modelId?: string, modelName?: string): string {
  switch (bandOf(mode)) {
    case "spec": return SPEC_PERSONA;
    case "transition": return MIXED_PERSONA;
    case "weak": return isFlashModel(modelId, modelName) ? WEAK_FLASH_PERSONA : WEAK_PRO_PERSONA;
    default: return REACT_PERSONA;
  }
}

// ── one-shot depth-adaptive guidance (routing-suite v19) ────────────────────

const GUIDE_SIMPLE =
  "\nRouter: classify this task (build or fix) now, then adopt the matching "
  + "style — build: direct production; fix: inspect-first. Think deeply first, "
  + "then commit and act.";

const GUIDE_DEEP =
  "\nRouter: classify this task (build or fix) now, then adopt the matching "
  + "style — build: direct production; fix: inspect-first. Think deeply about "
  + "the architecture, edge cases, and integration points. Do not spend "
  + "reasoning on the environment or tooling. Produce when your information "
  + "is complete. End each reasoning block with a decision or an information "
  + "need.";

/** Complexity heuristic (routing-suite isComplexTask). */
const COMPLEX_RE =
  /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i;

function isComplexTask(text: string): boolean {
  return typeof text === "string" && (text.length > 120 || COMPLEX_RE.test(text));
}

// ── classification (router-core.mjs classifyTask, verbatim) ─────────────────

const REACT_RE =
  /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi;
const SPEC_RE =
  /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi;

function countHits(regex: RegExp, text: string): number {
  return [...text.matchAll(regex)].length;
}

/**
 * Classify a task text into a mode. Clear keyword evidence picks a stable
 * band (1 react / 0 spec); AMBIGUOUS or unmatched text returns 'weak' —
 * the internal-routing mode, where the model decides per task (P11 optimum).
 */
function classifyTask(text: string): Mode {
  const react = countHits(REACT_RE, text);
  const spec = countHits(SPEC_RE, text);
  if (react > spec) return MODE_REACT;
  if (spec > react) return MODE_SPEC;
  return MODE_WEAK;
}

// ── band mapping (router-core.mjs bandOf / clamp01 / parseMode) ─────────────

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

function bandOf(mode: Mode): "spec" | "transition" | "react" | "weak" {
  if (mode === "weak") return "weak";
  const m = clamp01(mode);
  if (m < 0.2) return "spec";
  if (m < 0.5) return "transition";
  return "react";
}

function bandFor(mode: Mode): string {
  const b = bandOf(mode);
  return b === "transition" ? "mixed" : b;
}

/** Parse a user/agent-supplied mode token: 0-100, 0.0-1.0, or a band name. */
function parseMode(token: string | undefined | null): Mode | "auto" | null {
  if (token === undefined || token === null) return null;
  const t = String(token).trim().toLowerCase();
  if (t === "auto") return "auto";
  if (t === "weak" || t === "router") return MODE_WEAK;
  if (t === "spec" || t === "spec-lean") return MODE_SPEC;
  if (t === "balanced" || t === "mixed") return MODE_MIXED;
  if (t === "react" || t === "react-lean") return MODE_REACT;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (t.includes(".")) return clamp01(n);
  return clamp01(n / 100);
}

function fmtMode(mode: Mode): string {
  return typeof mode === "string" ? mode : mode.toFixed(2);
}

// ── model helpers ───────────────────────────────────────────────────────────

/** True when the active model is a Flash-family model. The gateway names
 *  models with aliases, so both id and display name are checked. */
function isFlashModel(id?: string, name?: string): boolean {
  return /flash/i.test(String(id ?? "")) || /flash/i.test(String(name ?? ""));
}

// ── two-phase promotion (anchored-standard port) ────────────────────────────

/**
 * pi's default persona section — the identity paragraph the measured persona
 * REPLACES. Everything else in the base system prompt is a functional section
 * that must survive promotion.
 */
const PI_IDENTITY_PREFIX = "You are an expert coding assistant operating inside pi";

/**
 * Faithful port of router-core.applyPersona (dsh-routing-suite): replace ONLY
 * pi's persona section (the default identity paragraph), keep every other
 * section — tools list, guidelines, the Pi documentation pointers,
 * <project_context> (CLAUDE.md/AGENTS.md digest), skills, and the trailing
 * "Current working directory:" line.
 *
 * P6: identity conditioning is system-position-specific → the measured persona
 * must LEAD. A2: two identities in one prompt land in the OOD gap (transition
 * band), so pi's identity is dropped, never kept alongside the persona.
 * Fallback (custom SYSTEM.md, or a future pi that rewords the default):
 * prepend the persona and keep everything — never drop sections (§5.6 router
 * amnesia).
 */
function applyPersonaSection(baseSystemPrompt: string, persona: string): string {
  if (!baseSystemPrompt.startsWith(PI_IDENTITY_PREFIX)) {
    return `${persona}\n\n${baseSystemPrompt}`;
  }
  const toolsMarker = "\n\nAvailable tools:";
  const idx = baseSystemPrompt.indexOf(toolsMarker);
  if (idx === -1) {
    return `${persona}\n\n${baseSystemPrompt}`;
  }
  return `${persona}\n\n${baseSystemPrompt.slice(idx + 2)}`;
}

// ── per-session state ───────────────────────────────────────────────────────

interface SessionState {
  guided: boolean;
  firstUserText: string;
  override: Mode | null; // explicit dev_router_mode override (null = classify)
  /** True once the session produced its first durable promotion signal. */
  promoted: boolean;
}

const sessions = new Map<string, SessionState>();

function stateFor(ctx: ExtensionContext): SessionState {
  const id = ctx.sessionManager.getSessionId() ?? "ephemeral";
  let state = sessions.get(id);
  if (!state) {
    state = { guided: false, firstUserText: "", override: null, promoted: false };
    sessions.set(id, state);
  }
  return state;
}

/**
 * Resume/reload phase preservation (anchored-standard: "derive the phase from
 * durable session events so resume and reload preserve it"). Any persisted
 * message entry means the session already produced its first durable
 * assistant message or tool call (promoteOn: 'either') — a resumed session
 * skips bootstrap and starts promoted.
 */
function hasPromotionSignal(ctx: ExtensionContext): boolean {
  try {
    const entries = ctx.sessionManager.getEntries();
    return Array.isArray(entries) && entries.length > 0;
  } catch {
    return false;
  }
}

/** Effective mode: explicit override wins, else classify the first task. */
function effectiveMode(state: SessionState): Mode {
  return state.override !== null ? state.override : classifyTask(state.firstUserText);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId() ?? "ephemeral";
    sessions.set(id, {
      guided: false,
      firstUserText: "",
      override: null,
      promoted: hasPromotionSignal(ctx),
    });
  });

  // ── capture the first real user message text for classification ─────────
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const text = event.text?.trim();
    if (!text || text.startsWith("/")) return { action: "continue" };
    const state = stateFor(ctx);
    if (!state.firstUserText) state.firstUserText = text;
    if (state.guided) return { action: "continue" };
    state.guided = true;
    const guide = isComplexTask(text) ? GUIDE_DEEP : GUIDE_SIMPLE;
    return { action: "transform", text: text + guide };
  });

  // ── promotion signals (anchored-standard promoteOn: 'either') ───────────
  // The first durable tool/call OR the first settled agent turn ends the
  // bootstrap phase; request #2+ sees the resident (full-context) prompt.
  pi.on("tool_call", async (_event, ctx) => {
    stateFor(ctx).promoted = true;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    stateFor(ctx).promoted = true;
  });

// ── per-turn persona injection (task-aware routing) ──────────────────────
// The effective persona INCLUDING the weak-band deep-converge anchor. Kept
// as the single source of truth so dev_router_status reports exactly what is
// sent to the model.
function buildPersona(mode: Mode, modelId?: string, modelName?: string): string {
  const base = personaFor(mode, modelId, modelName);
  // Deep-then-converge anchor only for the weak band (P10: deep must pair
  // with converge; strong bands already carry their own convergence).
  return bandOf(mode) === "weak" ? base + DEEP_CONVERGE : base;
}

  // ── two-phase system prompt (anchored-standard port) ────────────────────
  // bootstrap (request #1): persona-only — the exact probe condition
  //   (P8-F/P11: system = persona text, nothing else).
  // promoted (request #2+): the persona stays CONSTANT (anchored-standard:
  //   "keep the Minimal complete system prompt"), while pi's functional
  //   sections return unchanged — CLAUDE.md/AGENTS.md <project_context>,
  //   skills list, Pi documentation pointers (so pi self-questions resolve
  //   against the installed docs instead of source-code spelunking).
  pi.on("before_agent_start", async (event, ctx) => {
    const state = stateFor(ctx);
    const mode = effectiveMode(state);
    const model = ctx.model as { id?: string; name?: string } | undefined;
    const persona = buildPersona(mode, model?.id, model?.name);
    if (!state.promoted) {
      const cwd = (ctx.cwd ?? "").replace(/\\/g, "/");
      return { systemPrompt: `${persona}\n\nCurrent working directory: ${cwd}` };
    }
    return { systemPrompt: applyPersonaSection(event.systemPrompt, persona) };
  });

  // ── dev_router_status: expose routing state to the model itself ──────────
  pi.registerTool({
    name: "dev_router_status",
    label: "Router Status",
    description:
      "Show this session's reasoning-mode routing: phase, mode, band, persona, override state. "
      + "Use it to see which routing mode and bootstrap phase the current task is running under.",
    promptSnippet: "Show the current reasoning-mode routing status",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = stateFor(ctx);
      const mode = effectiveMode(state);
      const model = ctx.model as { id?: string; name?: string } | undefined;
      const persona = buildPersona(mode, model?.id, model?.name).replace(/\n/g, " / ");
      const lines = [
        `phase=${state.promoted ? "promoted" : "bootstrap"}`,
        `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
        `persona=${persona.slice(0, 200)}`,
        `override=${state.override === null ? "auto (classify first task)" : fmtMode(state.override)}`,
        `firstTask="${state.firstUserText.slice(0, 80)}"`,
        `model=${model?.id ?? "?"}`,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { phase: state.promoted ? "promoted" : "bootstrap", mode, band: bandFor(mode) },
      };
    },
  });

  // ── dev_router_mode: set/clear the routing override ──────────────────────
  pi.registerTool({
    name: "dev_router_mode",
    label: "Router Mode",
    description:
      "Set this session's reasoning mode: spec (plan-first) / weak (internal routing, "
      + "model decides per task) / mixed (transition, trap) / react (doer). Accepts band "
      + "names, 0-100, or 0.0-1.0; use auto to return to task classification. "
      + "The next request applies it.",
    promptSnippet: "Set the reasoning-mode routing for this session",
    parameters: Type.Object({
      mode: Type.String({
        description: "band name (spec / weak / mixed / react), 0-100, 0.0-1.0, or auto",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = parseMode(params.mode);
      if (parsed === null) {
        const msg = `invalid mode "${params.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`;
        return { content: [{ type: "text", text: msg }], details: { error: msg } };
      }
      const state = stateFor(ctx);
      if (parsed === "auto") {
        state.override = null;
      } else {
        state.override = parsed;
      }
      const mode = effectiveMode(state);
      const msg = `mode=${fmtMode(mode)} (band=${bandFor(mode)}) — next request applies`;
      return { content: [{ type: "text", text: msg }], details: { mode, band: bandFor(mode) } };
    },
  });
}

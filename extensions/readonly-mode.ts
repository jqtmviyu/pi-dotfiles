/**
 * Readonly Mode — Layer 1 (write/edit tool blocking) + Layer 2 (bash write-feature blocking).
 *
 * Layer 1: block the `write` / `edit` tools outright — exact tool names,
 *          no parsing, no bypass (structured tool names, not strings).
 * Layer 2: block bash commands that carry WRITE FEATURES — redirection,
 *          write commands, in-place edits, git/npm write subcommands.
 *          Blacklist (default allow) instead of whitelist: reads stay free.
 *
 * /readonly to enable, /readonly off to disable.
 * No system prompt injection, no extra messages, no cache impact.
 *
 * Known limits (honest): interpreter escapes (`python -c "open('f','w')"`,
 * `eval`, `sh -c 'rm ...'`) are NOT caught by regex. Layer 2 stops the
 * normal write path (echo > file, tee, rm, git commit ...) which is what a
 * model reaches for after Layer 1 blocks write/edit. For hard guarantees,
 * add Layer 3 (custom bash tool backed by a real sandbox / read-only ACL).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let enabled = false;

// ── Layer 1: exact tool names, no parsing needed ────────────────────────────
const BLOCKED_TOOLS = new Set(["write", "edit"]);

// ── Layer 2: bash write features (blacklist) ────────────────────────────────

/**
 * Redirection `>` / `>>`, but NOT fd duplication like `2>&1` / `>&2`
 * (stderr-to-stdout merge is a read-side op). `>` followed by `&` is an fd
 * redirect, not a file write.
 */
const REDIRECT_RE = />>?\s*[^&]/;

/** Commands whose primary effect is writing/removing files. */
const WRITE_CMD_RE =
  /^(rm|mv|cp|touch|mkdir|rmdir|truncate|dd|tee|ln|chmod|chown|install|shred|unlink|mktemp|unzip|zip)\b/;

/** In-place edits: sed -i / sed --in-place rewrite the file. */
const SED_INPLACE_RE = /\bsed\s+(?:-i|--in-place)\b/;

/** find -delete removes files without a write command at the start. */
const FIND_DELETE_RE = /\s-delete\b/;

/** tar extraction (-x*) / creation (-c*) writes files. */
const TAR_WRITE_RE = /\btar\s+-[a-zA-Z]*[xcX][a-zA-Z]*\b/;

/** git subcommands that mutate the working tree / refs / index. */
const GIT_WRITE_RE =
  /\bgit\s+(commit|push|pull|merge|rebase|reset|checkout|stash|clean|switch|restore|add|rm|mv|tag|init|clone)\b/;

/** npm subcommands that mutate node_modules / lockfiles. */
const NPM_WRITE_RE = /\bnpm\s+(install|i|uninstall|ci|update|add|remove|rm)\b/;

function isWriteBash(cmd: string): boolean {
  if (REDIRECT_RE.test(cmd)) return true;
  if (SED_INPLACE_RE.test(cmd)) return true;
  if (FIND_DELETE_RE.test(cmd)) return true;
  if (TAR_WRITE_RE.test(cmd)) return true;
  if (GIT_WRITE_RE.test(cmd)) return true;
  if (NPM_WRITE_RE.test(cmd)) return true;
  // Command chains (`;` / `&&` / `|`): check every segment for a write
  // command at its start, so `echo x && touch f` is caught segment-wise
  // while `cat a | grep x` stays free.
  return cmd.split(/[;&|]/).some((seg) => WRITE_CMD_RE.test(seg.trim()));
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("readonly", {
    description: "Toggle read-only mode",
    getArgumentCompletions: () => [
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ],
    handler: async (args, ctx) => {
      const off = args.trim().toLowerCase() === "off";
      enabled = !off;
      ctx.ui.notify(
        enabled
          ? "Read-only mode ON — write/edit blocked, bash writes blocked"
          : "Read-only mode OFF — full access restored",
        "info",
      );
    },
  });

  pi.on("tool_call", (event) => {
    if (!enabled) return;

    // Layer 1: exact tool names.
    if (BLOCKED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Read-only mode blocks '${event.toolName}'. You must not create or modify files. Use /readonly off to disable.`,
      };
    }

    // Layer 2: bash write features.
    if (event.toolName === "bash") {
      const cmd = typeof event.input?.command === "string" ? event.input.command : "";
      if (isWriteBash(cmd)) {
        return {
          block: true,
          reason: `Read-only mode blocks this bash command (it writes or modifies files): ${cmd.slice(0, 200)}`,
        };
      }
    }
  });

  pi.on("session_start", () => {
    enabled = false;
  });
}

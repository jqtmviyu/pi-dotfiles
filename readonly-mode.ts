/**
 * Readonly Mode — toggle with tool-call blocking only.
 * /readonly to enable, /readonly off to disable.
 * No system prompt injection, no extra messages, no cache impact.
 * LLM learns the rules from tool_call block reasons.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let enabled = false;

const BLOCKED = new Set(["write", "edit", "replace"]);

const SAFE_BASH = [
	"ls", "cat", "head", "tail", "wc", "sort", "uniq", "grep", "rg",
	"find", "which", "whereis", "echo", "date", "env", "printenv",
	"readlink", "realpath", "git diff", "git log", "git status",
	"git show", "git branch", "git tag", "git blame",
	"npm list", "npm view", "npm info",
];

function isSafeBash(cmd: string) {
	return SAFE_BASH.some(p => cmd.trim().startsWith(p));
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("readonly", {
		description: "Toggle read-only mode",
		getArgumentCompletions: (prefix: string) => {
			if (!prefix.trimStart()) return [{ value: "on", label: "on" }, { value: "off", label: "off" }];
			return [{ value: "on", label: "on" }, { value: "off", label: "off" }];
		},
		handler: async (_args, ctx) => {
			const off = _args.trim().toLowerCase() === "off";
			enabled = !off;
			ctx.ui.notify(
				`Read-only mode ${enabled ? "ON — write/edit/replace blocked" : "OFF — full access restored"}`,
				"info",
			);
		},
	});

	pi.on("tool_call", (event) => {
		if (!enabled) return;

		if (BLOCKED.has(event.toolName)) {
			return {
				block: true,
				reason: `Read-only mode blocks '${event.toolName}'. Use /readonly off to disable.`,
			};
		}

		if (event.toolName === "bash") {
			const cmd = typeof event.input?.command === "string" ? event.input.command : "";
			if (!isSafeBash(cmd)) {
				return {
					block: true,
					reason: `Read-only mode blocks bash: ${cmd}`,
				};
			}
		}
	});

	pi.on("session_start", () => {
		enabled = false;
	});
}

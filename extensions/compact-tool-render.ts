/**
 * Compact Tool Render — single-line tool rows.
 * Follows thinking block visibility: hidden → compact, visible → original.
 * Status: ○ not-started  ● running  ✓ done  ✗ error
 */
import { ToolExecutionComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

let compactMode = false;

function clip(s: string, max = 72) { return truncateToWidth(s, max); }
function lineCount(t: string) { return t.trim().split("\n").filter(l => l.length > 0).length; }
function firstLine(s: string) { return s.split("\n")[0] ?? ""; }

function getText(result: any): string {
	if (!result?.content) return "";
	return result.content.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("");
}

function isError(toolName: string, result: any, text: string): boolean {
	if (result?.isError) return true;
	if (toolName === "bash") {
		const m = text.match(/exit code:\s*(\d+)/i);
		if (m && Number(m[1]) !== 0) return true;
	}
	const h = text.trimStart().slice(0, 200).toLowerCase();
	return h.startsWith("error") || h.includes("not found") || h.includes("cannot find") || h.includes("permission denied") || h.includes("access denied");
}

function toolSummary(toolName: string, args: any): string {
	const a = (k: string) => typeof args?.[k] === "string" ? args[k] : "";
	switch (toolName) {
		case "bash": return `bash ${clip(a("command"))}`;
		case "read": case "write": case "edit": case "replace": {
			const file = a("path").split("/").pop() ?? "";
			return `${toolName} ${clip(file, 60)}`;
		}
		case "find": case "grep": {
			const pat = clip(a("pattern"), 30), dir = a("path") || a("directory") || "";
			const dirName = dir.split("/").pop() ?? dir;
			return `${toolName} ${pat} in ${clip(dirName, 40)}`;
		}
		case "ls": return `ls ${clip(a("path"), 60)}`;
		default: return toolName;
	}
}

function compactLine(self: any): string {
	const args = self.args ?? {}, result = self.result, name = self.toolName;
	const summary = toolSummary(name, args), text = getText(result);
	const error = (result && !self.isPartial) ? isError(name, result, text) : false;

	let dot: string;
	if (result && !self.isPartial) {
		dot = error ? "\x1b[31m✗\x1b[39m" : "\x1b[32m✓\x1b[39m";
	} else if (!self.executionStarted) {
		dot = "\x1b[2m○\x1b[22m";
	} else if (self.isPartial) {
		dot = "\x1b[33m●\x1b[39m";
	} else {
		dot = "\x1b[32m✓\x1b[39m";
	}

	let suffix = "";
	if (result && !self.isPartial) {
		suffix = error ? " → " + firstLine(text).slice(0, 60) : lineCount(text) ? ` · ${lineCount(text)}L` : " · ok";
	} else if (self.isPartial && self.executionStarted) {
		const ls = text.trim().split("\n").filter((l: string) => l.length > 0).slice(-3);
		if (ls.length) suffix = "\n" + ls.map((l: string) => "│ " + clip(l, 120)).join("\n");
	}

	return dot + " " + summary + suffix;
}

const _render = ToolExecutionComponent.prototype.render;

ToolExecutionComponent.prototype.render = function (width: number): string[] {
	const self = this as any;
	if (compactMode && !self.expanded) {
		// write/replace/edit go to original render (shows diff preview)
		if (self.toolName === "write" || self.toolName === "replace" || self.toolName === "edit") {
			return _render.call(self, width);
		}
		const line = compactLine(self);
		const maxW = Math.max(20, width - 4);
		if (visibleWidth(line) > maxW) {
			return [truncateToWidth(line, maxW)];
		}
		return [line];
	}
	return _render.call(self, width);
};
const _toggleThinking = InteractiveMode.prototype.toggleThinkingBlockVisibility;

InteractiveMode.prototype.toggleThinkingBlockVisibility = function () {
	_toggleThinking.call(this);
	compactMode = (this as any).hideThinkingBlock;
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		try {
			const { homedir } = await import("os");
			const { readFileSync } = await import("fs");
			const raw = readFileSync(`${homedir()}/.pi/agent/settings.json`, "utf-8");
			const settings = JSON.parse(raw);
			compactMode = settings.hideThinkingBlock === true;
		} catch {
			compactMode = true;
		}
	});
}

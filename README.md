# Pi Coding Agent Extensions

## compact-tool-render

Compact tool render — displays tool calls as single-line rows instead of full cards.
Follows thinking block visibility: hidden → compact, visible → original.

Install:
```bash
cp compact-tool-render.ts ~/.pi/agent/extensions/
```

## readonly-mode

Toggle read-only mode with `/readonly` command. Blocks write/edit/replace tool calls and unsafe bash commands.

- `/readonly` — enable
- `/readonly off` — disable

Install:
```bash
cp readonly-mode.ts ~/.pi/agent/extensions/
```

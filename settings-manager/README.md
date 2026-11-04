# Settings Manager

A Claude Code mod that controls your setup from one desktop window. It works in the terminal and in the Code tab of the desktop app.

Run `/settings-manager` to open the window. The window needs Node.js on PATH. It opens in Microsoft Edge or Google Chrome app mode, so it has no browser bars. On Windows, `app/window.ps1` replaces the native title bar with the window's own title bar.

## What it controls

| Section | Where the state lives |
| --- | --- |
| Skills | Every skill has a folder in `.claude/skills/<name>/`. A turned-off skill moves to `.claude/skills/disabled/<name>/`. Built-in, synced and plugin skills get a folder that holds `skill.json`. |
| System prompt | Each section is a file in `.claude/prompts/<id>.md`. A turned-off section moves to `.claude/prompts/disabled/`. Claude reads your edited text. Reset to default undoes an edit. |
| Reminders | Each reminder type is a file in `.claude/prompts/reminders/`. A turned-off reminder moves to `.claude/prompts/reminders/disabled/`. Claude reads your edited text. Reset to default undoes an edit. |
| Subagents | Your agent files move to `.claude/agents/disabled/`. Other agent types get a marker file there. |
| Commands | A turned-off command gets a marker file in `.claude/commands/disabled/`. It is hidden and refused. |
| Tools | A turned-off tool is added to `permissions.deny` in `settings.json`. |
| Plugins | `enabledPlugins` in `settings.json`. |
| Hooks | A turned-off settings hook moves from `settings.json` to `.claude/hooks/disabled/<id>.json`. |
| General | Model, effort, output style, permission mode and other keys in `settings.json`. |

The mod keeps Claude Code's original text for each section and reminder in `.claude/settings-manager/prompt-defaults.json`, and updates it when Claude Code's text changes. The mod writes `.claude/settings-manager/catalog.json` with the items that it sees in sessions. The window reads it, so start a session with the mod loaded before you open the window.

Most changes reach Claude in new sessions.

## Install

```
/plugin install settings-manager --marketplace MahadSalim/claude-mods
```

## Test

```
claude plugin test settings-manager
```

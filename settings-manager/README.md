# Settings Manager

A Claude Code mod that controls your setup from one desktop window. It works in the terminal and in the Code tab of the desktop app.

Run `/settings-manager` to open the window. The window needs Node.js on PATH. On Windows, `app/window.ps1` opens it in a WebView2 window with its own title bar, using the WebView2 SDK files in `app/webview2`. On macOS and Linux, it opens in Microsoft Edge or Google Chrome app mode, so it has no browser bars.

## What it controls

| Section | Where the state lives |
| --- | --- |
| Skills | `skills` in `disabled.json`. A turned-off skill leaves the skill list, and the Skill tool refuses it. |
| System prompt | `sections` in `disabled.json`. Each section is a file in `.claude/prompts/<id>.md`. Claude reads your edited text. Reset to default undoes an edit. |
| Reminders | `reminders` in `disabled.json`. Each reminder type is a file in `.claude/prompts/reminders/`. Claude reads your edited text. Reset to default undoes an edit. |
| Subagents | `agents` in `disabled.json`. Claude is not offered a turned-off subagent. |
| Commands | `commands` in `disabled.json`. A turned-off command is hidden and refused. |
| Tools | A turned-off tool is added to `permissions.deny` in `settings.json`. |
| Plugins | `enabledPlugins` in `settings.json`. |
| Hooks | A turned-off settings hook moves from `settings.json` to `hooks` in `disabled.json`, which keeps it to turn back on. |
| General | Model, effort, output style, permission mode and other keys in `settings.json`. |
| Environment | `env` in `settings.json`. Values of names such as `API_KEY` or `GITHUB_TOKEN` are hidden until you click the eye button. |

`disabled.json` is `.claude/settings-manager/disabled.json`. It lists what is turned off by name, one list for each kind. Claude Code still loads a turned-off skill, subagent or command, and the mod keeps it from Claude. So without the mod, everything is on again. Older versions moved turned-off items into `disabled` folders. The window moves that state into `disabled.json` when it starts, and puts your own files back.

An edit counts only when you make it in the window, which records it in `.claude/settings-manager/prompt-edits.json`. Without that record, Claude reads Claude Code's own text, and the mod writes that text to the file. Messages that you send while Claude works always reach Claude unchanged, and the mod never saves them. Reminders that carry file contents can be turned off, but the mod never saves or edits their text.

The mod keeps Claude Code's original text for each section and reminder in `.claude/settings-manager/prompt-defaults.json`, and updates it when Claude Code's text changes. The mod writes `.claude/settings-manager/catalog.json` with the items that it sees in sessions. The window reads it, so start a session with the mod loaded before you open the window.

Most changes reach Claude in new sessions.

## Undo

The Undo button at the top of each page undoes the last change that the window made. Click it again to undo the change before that. The window keeps the last 50 changes in `.claude/settings-manager/history.json`, with the text of each file before and after the change. That file can hold the values of your environment variables, the same as `settings.json`.

Undo checks each file first. If a file changed after the window changed it, Undo leaves the file as it is, shows which file changed, and removes that change from the list.

## Install

```
/plugin install settings-manager --marketplace MahadSalim/claude-mods
```

## Window UI

The window is a React app with Tailwind CSS and shadcn/ui components. Its source is in `ui/`, and `app/main.mjs` serves the built files from `app/dist`. `app/dist` is committed, so the mod runs with Node.js only.

After you change the UI, rebuild it:

```
cd ui
npm install
npm run build
```

## Test

```
claude plugin test settings-manager
node --test settings-manager/tests/migrate.test.mjs
cd ui && npm test
```

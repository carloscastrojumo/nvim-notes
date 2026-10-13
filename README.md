<p align="center"><img src="assets/icon.svg" width="128" alt=""></p>

# nvim-notes

The Claude Code half of [claude-notes.nvim](https://github.com/carloscastrojumo/claude-notes.nvim). You leave notes on code in Neovim. A Claude Code session running this mod picks them up and writes each reply back next to the code. If a note is unclear, Claude asks, and the question lands in Neovim rather than in a chat you're not watching.

```
✎ nvim notes: 2 open · 1 with Claude · 1 waiting on you in Neovim  [ Send 2 ]
```

It's a mod, a Claude Code plugin built on function hooks. That API is early access and can change between Claude Code releases; this one was built against 2.1.296.

## Install

Clone it and load it from disk:

```sh
git clone https://github.com/carloscastrojumo/claude-notes-mod
claude --plugin-dir <path to the clone>
```

To load it in every session without the flag, set `CLAUDE_CODE_PLUGIN_DIRS` to that path in the `env` block of `~/.claude/settings.json`.

If your Claude Code accepts marketplaces outside your organisation's list, it also installs as a plugin:

```
/plugin install nvim-notes --marketplace carloscastrojumo/claude-notes-mod
```

## Use

1. Run `/notes watch` in the session that should work on your notes. A band above the prompt shows what's open, queued, with Claude, or waiting on you.
2. Notes you send from Neovim with `<leader>aS` arrive within about 1.5 s, as one prompt.
3. Claude marks each note done with a one-line reply, or asks about it. The question goes to Neovim, and your answer comes back with the note.

Only a watching session picks up notes, so with several sessions open in one repository you choose which one gets them. A session that isn't watching shows nothing.

| Command | |
| --- | --- |
| `/notes` or `/notes send` | Send open and queued notes from this session, watching or not |
| `/notes watch` / `/notes unwatch` | Turn pickup on or off for this session |
| `/notes list` | List the notes |
| `/notes reopen` | Put notes Claude never finished back to open |
| `/notes clear` | Remove done notes |
| `/notes path` | Show the notes file |

## How it works

Claude gets two tools, `resolve_note` and `ask_about_note`. During a notes turn the built-in question dialog is refused in favour of `ask_about_note`. When the turn ends, notes Claude didn't touch get its last message as their question, and an interrupted turn puts them back to open.

Notes live in `<git dir>/claude-notes.json`, shared with the Neovim plugin, so they never get committed. Before sending, the session writes its id into each note, waits 300 ms and reads the file back, so two watching sessions don't send the same note. Notes and the code they point at go to the model, so keep secrets and customer data out of them.

## Options

`delivery`, in `/config`: `manual` by default. `auto` sends new notes a few seconds after they stop arriving.

## Tests

```sh
claude plugin validate .
claude plugin test .
```

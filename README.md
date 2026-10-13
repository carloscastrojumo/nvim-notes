# nvim-notes

The Claude Code half of [claude-notes.nvim](https://github.com/carloscastrojumo/claude-notes.nvim). You leave notes on code in Neovim; a Claude Code session running this mod picks them up, works through them, and writes each reply back next to the code.

It's a mod (a Claude Code plugin built on function hooks), so the API it uses is early access and may change between Claude Code releases. Built against 2.1.296.

## Install

```
/plugin install nvim-notes --marketplace carloscastrojumo/claude-notes-mod
```

Answer `y` to add the marketplace, then pick a scope. For a local checkout, `claude --plugin-dir <path to this repo>` loads it for one session.

## Use

Run `/notes watch` in the session that should work on your notes. A session that isn't watching shows nothing and picks up nothing, so with several sessions in one repository you choose which one gets them.

A watching session:

- shows a band above the prompt with the counts and a Send button,
- sends notes queued from Neovim within about 1.5 s, as one prompt,
- gives Claude a `resolve_note` tool to mark each note done with a one-line reply,
- gives Claude an `ask_about_note` tool for unclear notes. The question shows up in Neovim and your answer comes back with the note.

During a notes turn the built-in question dialog is refused in favour of `ask_about_note`. Notes a finished turn left untouched get Claude's last message as their question; an interrupted turn puts them back to open.

| Command | |
| --- | --- |
| `/notes` or `/notes send` | Send open and queued notes from this session, watching or not |
| `/notes watch` / `/notes unwatch` | Turn pickup on or off for this session |
| `/notes list` | List the notes |
| `/notes reopen` | Put notes Claude never finished back to open |
| `/notes clear` | Remove done notes |
| `/notes path` | Show the notes file |

Delivery is `manual` by default. Set the `delivery` option to `auto` (in `/config`) to send new notes a few seconds after they stop arriving.

## How it works

Notes live in `<git dir>/claude-notes.json`, shared with the Neovim plugin, so they're never committed. Before sending, a session writes its id into each note, waits 300 ms and reads the file back, so two watching sessions don't send the same note.

## Tests

```sh
claude plugin validate .
claude plugin test .
```

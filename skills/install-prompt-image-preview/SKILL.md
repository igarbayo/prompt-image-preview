---
name: install-prompt-image-preview
description: Install, check or remove the prompt-image-preview mod for Claude Code, including the shell setting Orca needs to draw image thumbnails. Use when the user asks to install, set up, check, update or uninstall prompt-image-preview, or wants pasted images previewed above the Claude Code prompt in Orca.
---

# Install prompt-image-preview

Runs one script. Do not install by hand or improvise other steps.

## Steps

1. Run the script with the mode the user asked for:

   ```sh
   bash "<this skill's folder>/scripts/install.sh" install
   ```

   Modes: `install` (default), `status`, `uninstall`.

2. Report the script's `ok:`, `warning:` and `error:` lines as they are. Do not retry a failed step with another method.

3. After `install`, tell the user to open a new Orca terminal tab, start `claude` and paste an image. The current tab keeps the old shell environment.

## What the script does

- Checks for macOS, `claude` and `jq`. The mod needs macOS because it reads the clipboard with `osascript` and resizes with `sips`.
- Installs the plugin at user scope: `claude plugin install prompt-image-preview --marketplace igarbayo/prompt-image-preview --scope user`. Skips it when it is already installed.
- Adds this line to `~/.zshrc` (and `~/.bashrc` if it exists), unless the file already sets `CLAUDE_CODE_FORCE_TERMINAL_IMAGES`:

  ```sh
  [[ "$TERM_PROGRAM" == "Orca" ]] && export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
  ```

  Orca can draw kitty graphics, but Claude Code does not recognize Orca as an image-capable terminal, so it falls back to text. The variable forces images only inside Orca. Ghostty, kitty and WezTerm need nothing.
- Warns when `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` also loads a local copy of the mod, which would load it twice.
- `uninstall` removes the plugin and the line it added.

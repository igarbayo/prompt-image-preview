#!/usr/bin/env bash
# Installs or removes the prompt-image-preview mod for Claude Code and the shell
# setting that lets Orca draw its thumbnails. Safe to run more than once.
set -euo pipefail

PLUGIN="prompt-image-preview"
MARKETPLACE="igarbayo/prompt-image-preview"
MARKER="# prompt-image-preview: Orca draws kitty images but Claude Code does not detect it"
LINE='[[ "$TERM_PROGRAM" == "Orca" ]] && export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1'
SETTINGS="$HOME/.claude/settings.json"

mode="${1:-install}"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

shell_rc_files() {
  local files=()
  [[ -f "$HOME/.zshrc" || "${SHELL:-}" == */zsh ]] && files+=("$HOME/.zshrc")
  [[ -f "$HOME/.bashrc" ]] && files+=("$HOME/.bashrc")
  printf '%s\n' "${files[@]}"
}

is_installed() {
  claude plugin list --json | jq -e --arg p "$PLUGIN@" 'any(.[]; .id | startswith($p))' >/dev/null
}

check_requirements() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "macOS only: the mod reads the clipboard with osascript and resizes with sips."
  command -v claude >/dev/null || fail "claude is not on PATH."
  command -v jq >/dev/null || fail "jq is required (brew install jq)."
}

warn_dev_copy() {
  if [[ -f "$SETTINGS" ]] && jq -e '.env.CLAUDE_CODE_PLUGIN_DIRS // "" | test("prompt-image-preview")' "$SETTINGS" >/dev/null; then
    say "warning: CLAUDE_CODE_PLUGIN_DIRS in $SETTINGS also loads a local copy of $PLUGIN."
    say "         Remove that entry so the mod is not loaded twice."
  fi
}

install() {
  check_requirements
  if is_installed; then
    say "ok: $PLUGIN is already installed."
  else
    claude plugin install "$PLUGIN" --marketplace "$MARKETPLACE" --scope user
    is_installed || fail "the plugin did not install."
    say "ok: installed $PLUGIN from $MARKETPLACE."
  fi

  while IFS= read -r rc; do
    [[ -n "$rc" ]] || continue
    if grep -qF "CLAUDE_CODE_FORCE_TERMINAL_IMAGES" "$rc" 2>/dev/null; then
      say "ok: $rc already sets CLAUDE_CODE_FORCE_TERMINAL_IMAGES."
    else
      printf '\n%s\n%s\n' "$MARKER" "$LINE" >> "$rc"
      say "ok: added the Orca setting to $rc."
    fi
  done < <(shell_rc_files)

  warn_dev_copy
  say "done: open a new Orca terminal tab, start claude and paste an image."
}

uninstall() {
  check_requirements
  if is_installed; then
    claude plugin uninstall "$PLUGIN" --scope user
    say "ok: uninstalled $PLUGIN."
  else
    say "ok: $PLUGIN was not installed."
  fi

  while IFS= read -r rc; do
    [[ -n "$rc" && -f "$rc" ]] || continue
    if grep -qF "$MARKER" "$rc"; then
      local tmp
      tmp="$(mktemp)"
      awk -v marker="$MARKER" -v line="$LINE" '
        $0 == marker { skip = 1; next }
        skip && $0 == line { skip = 0; next }
        { skip = 0; print }
      ' "$rc" > "$tmp"
      cat "$tmp" > "$rc"
      rm -f "$tmp"
      say "ok: removed the Orca setting from $rc."
    fi
  done < <(shell_rc_files)
}

status() {
  check_requirements
  if is_installed; then
    say "plugin: installed as $(claude plugin list --json | jq -r --arg p "$PLUGIN@" '[.[] | select(.id | startswith($p)) | .id] | join(", ")')"
  else
    say "plugin: not installed"
  fi
  while IFS= read -r rc; do
    [[ -n "$rc" ]] || continue
    if grep -qF "CLAUDE_CODE_FORCE_TERMINAL_IMAGES" "$rc" 2>/dev/null; then say "orca setting: present in $rc"; else say "orca setting: missing in $rc"; fi
  done < <(shell_rc_files)
  warn_dev_copy
}

case "$mode" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *) fail "usage: install.sh [install|uninstall|status]" ;;
esac

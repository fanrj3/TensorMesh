#!/usr/bin/env bash
set -u

SOCKET="${1:-}"
TMESH="${2:-tmesh}"
COMMAND="${3:-}"
SESSION="${4:-}"
if [[ $# -ge 7 ]]; then
  TARGET_PANE="${5:-$SESSION}"
  JOB="${6:-}"
  LOG="${7:-}"
else
  TARGET_PANE="$SESSION"
  JOB="${5:-}"
  LOG="${6:-}"
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SUBMIT_MONITOR="$SCRIPT_DIR/tmux_submit_monitor.py"

COMMAND="${COMMAND#:}"
COMMAND="${COMMAND#/}"
COMMAND="$(printf '%s' "$COMMAND" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

tmux_cmd() {
  tmux -L "$SOCKET" "$@"
}

pause_suffix='printf "\nPress Enter to close."; read _'
split_target="${TARGET_PANE:-$SESSION}"

show_message() {
  tmux_cmd display-message -t "$split_target" "$1"
}

split_panel() {
  local _height="$1"
  local body="$2"
  if [[ -n "$split_target" ]]; then
    tmux_cmd split-window -d -p 55 -t "$split_target" "$body"
    tmux_cmd select-pane -t "$split_target" >/dev/null 2>&1 || true
  else
    tmux_cmd split-window -d -p 55 "$body"
  fi
}

case "$COMMAND" in
  ""|resume|q|quit)
    show_message "TensorMesh resumed"
    ;;
  help)
    split_panel 12 "printf '%s\n' 'TensorMesh commands:' '  job      show current Slurm job' '  jobs     show Slurm jobs' '  status   show TensorMesh status' '  log      tail current bash.log' '  notice   run tmesh notice' '  close    detach this terminal from the shared shell' '  cancel   cancel current Slurm job and close session' '  submit   detach this terminal; work keeps running in background'; $pause_suffix"
    ;;
  job)
    if [[ -n "$JOB" ]]; then
      split_panel 24 "$TMESH job '$JOB'; $pause_suffix"
    else
      show_message "TensorMesh job id is not ready"
    fi
    ;;
  jobs)
    split_panel 24 "$TMESH jobs --all; $pause_suffix"
    ;;
  status)
    split_panel 32 "$TMESH status --all; $pause_suffix"
    ;;
  log)
    if [[ -n "$LOG" && -f "$LOG" ]]; then
      split_panel 24 "less -R +G '$LOG'"
    else
      show_message "TensorMesh log is not ready"
    fi
    ;;
  notice|notice\ *)
    split_panel 24 "$TMESH notice ${COMMAND#notice}; $pause_suffix"
    ;;
  cancel)
    if [[ -n "$JOB" ]]; then
      tmux_cmd split-window -p 55 -t "$split_target" "$TMESH cancel '$JOB' && tmux -L '$SOCKET' kill-session -t '$SESSION'"
    else
      show_message "TensorMesh job id is not ready"
    fi
    ;;
  close|detach)
    show_message "TensorMesh client detached"
    tmux_cmd detach-client >/dev/null 2>&1 || true
    ;;
  submit)
    if [[ -z "$JOB" ]]; then
      show_message "Cannot submit: TensorMesh job id is not ready"
      exit 0
    fi
    if [[ ! -x "$SUBMIT_MONITOR" && ! -f "$SUBMIT_MONITOR" ]]; then
      show_message "Cannot submit: submit monitor is missing"
      exit 0
    fi
    if ! detail="$(/usr/bin/python3 "$SUBMIT_MONITOR" --job "$JOB" --socket "$SOCKET" --session "$SESSION" --pane "$split_target" --check 2>&1)"; then
      show_message "Cannot submit: $detail"
      exit 0
    fi
    nohup /usr/bin/python3 "$SUBMIT_MONITOR" --job "$JOB" --socket "$SOCKET" --session "$SESSION" --pane "$split_target" >/dev/null 2>&1 &
    tmux_cmd set-option -t "$SESSION" @tmesh_submitted "1" >/dev/null 2>&1 || true
    show_message "Submitted job $JOB ($detail). Reopen with: tmesh open $JOB"
    tmux_cmd detach-client >/dev/null 2>&1 || true
    ;;
  *)
    show_message "Unknown TensorMesh command: $COMMAND"
    ;;
esac

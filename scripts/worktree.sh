#!/usr/bin/env bash
# worktree.sh — isolated workspaces for parallel Claude sessions.
#
# WHY THIS EXISTS
# Several Claude sessions run against this repo at once. Editing different files is
# not enough to keep them apart: a single checkout shares HEAD, the index, the stash
# and the working tree. On 2026-07-16 that produced a session's edits swept into
# another's stash, an untested commit shipped inside someone else's push, and commits
# landing on the wrong branch after a background checkout. On 2026-08-01 a stray
# scratch spec left by one session red-lit another session's pre-push gate.
#
# A worktree gives each session its own HEAD, index, stash and files. Only the object
# store and refs are shared. That removes the whole class of problem.
#
#   ./scripts/worktree.sh new  <topic> [fix|feature|chore]   create and enter a workspace
#   ./scripts/worktree.sh list                               show workspaces, ports, risk
#   ./scripts/worktree.sh done <topic>                       remove it, once it is safe to
#
# The main checkout stays on main for quick fixes, the daily sweep and deploys.
# Use a workspace for anything multi-file or long-running.

set -euo pipefail

COMMON_DIR="$(git rev-parse --git-common-dir)"
COMMON_DIR="$(cd "$COMMON_DIR" && pwd)"
MAIN_ROOT="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
WT_DIR="$MAIN_ROOT/.claude/worktrees"
LAUNCH="$MAIN_ROOT/.claude/launch.json"
REGISTRY="$COMMON_DIR/worktree-ports"   # inside .git: never committed, shared by all worktrees

die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[32m%s\033[0m\n' "$*"; }
note(){ printf '  %s\n' "$*"; }

# Preview servers are declared in .claude/launch.json, which is a tracked, shared file.
# Handing each workspace one of the EXISTING named configs means no session ever edits
# it — an edit there would show up as a diff in every worktree and eventually get
# committed by whoever ran `git add -A` first.
config_names() {
    python3 -c "
import json,sys
try: d=json.load(open('$LAUNCH'))
except Exception: sys.exit(0)
for c in d.get('configurations',[]): print(c['name'], c.get('port',''))
"
}

assigned_config() { [ -f "$REGISTRY" ] && awk -v t="$1" -F'\t' '$1==t{print $2" "$3}' "$REGISTRY" || true; }

# The FIRST config in launch.json is reserved for the main checkout — that is where the
# daily sweep, quick fixes and deploy verification run, and it is the one already running
# when a session opens. Handing it to a workspace as well puts two servers on one port,
# which surfaces as a preview that silently serves the wrong worktree's files.
claim_config() {
    local topic="$1" used name port first=1
    touch "$REGISTRY"
    used="$(cut -f2 "$REGISTRY" 2>/dev/null || true)"
    while read -r name port; do
        [ -z "$name" ] && continue
        if [ "$first" = 1 ]; then first=0; continue; fi
        if ! printf '%s\n' "$used" | grep -qx "$name"; then
            printf '%s\t%s\t%s\n' "$topic" "$name" "$port" >> "$REGISTRY"
            printf '%s %s' "$name" "$port"; return 0
        fi
    done < <(config_names)
    return 1
}

release_config() {
    [ -f "$REGISTRY" ] || return 0
    awk -v t="$1" -F'\t' '$1!=t' "$REGISTRY" > "$REGISTRY.tmp"
    mv "$REGISTRY.tmp" "$REGISTRY"
}

# Returns 0 and echoes the count when the branch HAS an upstream; returns 1 when it has
# none. These are different situations and must not be conflated: a branch that was never
# pushed exists ONLY in this worktree, so `wc -l` on a failed `git log` quietly reporting
# "0 unpushed" would green-light deleting the only copy.
unpushed_count() {
    local p="$1"
    git -C "$p" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || return 1
    git -C "$p" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0
}

cmd_new() {
    local topic="${1:-}" kind="${2:-feature}"
    [ -n "$topic" ] || die "Usage: worktree.sh new <topic> [fix|feature|chore]"
    printf '%s' "$topic" | grep -qE '^[a-z0-9][a-z0-9-]*$' \
        || die "Topic must be lowercase letters, numbers and hyphens (got: $topic)"
    case "$kind" in fix|feature|chore) ;; *) die "Kind must be fix, feature or chore (got: $kind)";; esac

    local path="$WT_DIR/$topic" branch="$kind/$topic"
    [ -e "$path" ] && die "Already exists: $path
Run './scripts/worktree.sh done $topic' first, or pick another topic."
    git show-ref --verify --quiet "refs/heads/$branch" \
        && die "Branch $branch already exists. Pick another topic, or check it out where it is."

    # Branch from the REMOTE tip, not local main. Local main in a shared checkout is
    # whatever the last session left behind, and may be mid-rebase or simply stale.
    note "Fetching origin/main..."
    git fetch -q origin main

    mkdir -p "$WT_DIR"
    # --no-track is load-bearing. Branching off origin/main without it sets the new
    # branch's upstream TO origin/main, which is the trap behind "never a bare git push":
    # from such a branch, push configurations other than the default fire straight at
    # main. It also breaks the "has this been pushed?" check below, because every commit
    # then reads as merely ahead-of-main rather than existing nowhere but here.
    # Upstream gets set properly by the `git push -u origin <branch>` printed below.
    git worktree add -q --no-track "$path" -b "$branch" origin/main
    ok "Created $path on $branch (from origin/main, no upstream until you push)"

    local cfg name port
    if cfg="$(claim_config "$topic")"; then
        name="${cfg%% *}"; port="${cfg##* }"
        note "Preview server: config '$name' on port $port"
    else
        name=""; note "No free preview config in .claude/launch.json — add one if this session needs a preview."
    fi

    # Hooks live in the shared common dir, so the pre-push gate applies here automatically.
    if [ -e "$COMMON_DIR/hooks/pre-push" ]; then
        note "Pre-push gate: active (shared hook, runs vitest then Playwright)"
    else
        note "Pre-push gate: NOT installed — run: ln -sf ../../scripts/pre-push $COMMON_DIR/hooks/pre-push"
    fi

    printf '\n'
    ok "Next:"
    note "cd $path"
    [ -n "$name" ] && note "preview_start with config name: $name"
    note "git push -u origin $branch      # push early, unpushed work is the losable kind"
    note "./scripts/worktree.sh done $topic   # when it has merged"
}

cmd_list() {
    printf '\n%-22s %-28s %-18s %s\n' "TOPIC" "BRANCH" "PREVIEW" "STATE"
    printf '%s\n' "---------------------------------------------------------------------------------------"
    local found=0
    while read -r path; do
        [ -z "$path" ] && continue
        local topic branch cfg state unpushed dirty
        topic="$(basename "$path")"
        branch="$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
        [ "$path" = "$MAIN_ROOT" ] && topic="(main checkout)"
        cfg="$(assigned_config "$topic")"; [ -z "$cfg" ] && cfg="-"
        dirty="$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
        unpushed="$(unpushed_count "$path" || echo 'never-pushed')"
        state=""
        [ "$unpushed" = "never-pushed" ] && state="never pushed"
        [ "$unpushed" != "never-pushed" ] && [ "$unpushed" != "0" ] && state="$unpushed unpushed commit(s)"
        [ "$dirty" != "0" ] && state="${state:+$state, }$dirty uncommitted file(s)"
        [ -z "$state" ] && state="clean"
        printf '%-22s %-28s %-18s %s\n' "$topic" "$branch" "$cfg" "$state"
        found=1
    done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')
    [ "$found" = 0 ] && note "(none)"
    printf '\n'
}

cmd_done() {
    local topic="${1:-}" force="${2:-}"
    [ -n "$topic" ] || die "Usage: worktree.sh done <topic> [--force]"
    local path="$WT_DIR/$topic"
    [ -d "$path" ] || die "No workspace at $path. Run './scripts/worktree.sh list'."

    local branch dirty unpushed
    branch="$(git -C "$path" rev-parse --abbrev-ref HEAD)"
    dirty="$(git -C "$path" status --porcelain | wc -l | tr -d ' ')"
    unpushed="$(unpushed_count "$path" || echo 'never-pushed')"

    # Refuse by default. Removing a worktree deletes its files, and work that is only
    # here exists nowhere else — the one genuinely unrecoverable mistake this tool could
    # make. The order matters: ask "does this branch contain anything origin/main does
    # not?" FIRST. If it does not, there is nothing to lose and the workspace goes,
    # whether or not the branch was ever pushed. Checking "was it pushed?" first instead
    # would strand every workspace where the session turned out to have nothing to commit.
    if [ "$force" != "--force" ]; then
        [ "$dirty" != "0" ] && die "$topic has $dirty uncommitted file(s). Commit or discard them first:
  git -C $path status
Then re-run. Use --force only if you are certain the changes are disposable."

        git fetch -q origin main
        if ! git merge-base --is-ancestor "$branch" origin/main 2>/dev/null; then
            if [ "$unpushed" = "never-pushed" ]; then
                die "$branch has commits that exist ONLY here — it has never been pushed.
Push them first, then merge:
  git -C $path push -u origin $branch"
            fi
            [ "$unpushed" != "0" ] && die "$topic has $unpushed commit(s) that exist only here. Push first:
  git -C $path push origin $branch"
            die "$branch is pushed but not merged into origin/main — its work would be orphaned.
Merge it (or open the PR) first, then re-run. Use --force to remove it anyway."
        fi
    fi

    git worktree remove ${force:+--force} "$path"
    git branch -D "$branch" >/dev/null 2>&1 || true
    release_config "$topic"
    ok "Removed workspace $topic and branch $branch"
}

case "${1:-}" in
    new)  shift; cmd_new "$@" ;;
    list) shift 2>/dev/null || true; cmd_list ;;
    done) shift; cmd_done "$@" ;;
    *)    sed -n '1,22p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

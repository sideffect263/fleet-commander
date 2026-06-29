// danger.mjs — the LOCAL, authoritative "is this command irreversible?" check
// for the approval hook.
//
// The phone app hides the "allow this tool for the session" control for dangerous
// commands (FleetMapView/WatchRootView `isDangerous`), but that gate is
// client-side and advisory — a forged backend response or a bypassed app could
// still send scope='session' for a `rm -rf`. THIS runs on your machine inside the
// PreToolUse hook, where it sees the real, untruncated command, so it is the
// enforcement point: an irreversible command can never ride a blanket session
// grant. It must be approved explicitly, per command, every time.
//
// Why coverage matters: a session grant is keyed by TOOL (Bash), not by command,
// and lasts 24h. So once Bash is whitelisted, only commands THIS list recognizes
// re-page — anything missed runs silently. The denylist is the security boundary,
// so it deliberately covers the high-frequency, irreversible commands across git
// history-destruction, filesystem data-loss, disk/device writes, SQL/datastore,
// and IaC/kubernetes/cloud-CLI/container teardown.
//
// Trade-off: a false positive only costs one extra per-command approval (a safe
// failure mode), so we err toward flagging — BUT every rule anchors on the command
// name AND its destructive flag/sub-action, never the bare verb, so everyday
// commands (`git checkout main`, `git stash`, `find . -name`, `chmod 644`,
// `kubectl get`, `terraform plan`, `> newfile.log`, `DELETE ... WHERE`) stay quiet.
//
// Matching runs against the RAW command (not lowercased) so case-significant flags
// like `git branch -D` (force-delete) vs `-d` (safe) are distinguishable; patterns
// that should ignore case carry the /i flag.

// Destructive `rm`: the `rm` command itself carrying BOTH a recursive and a force
// flag, in any order/spelling (`-rf`, `-fr`, `-r -f`, `--recursive --force`). A
// bare `rm file` or `rm -i` isn't flagged; `grep -rf`, `npm run format` etc. have
// no standalone `rm`.
function isDestructiveRm(s) {
  if (!/\brm\b/i.test(s)) return false
  const recursive = /(^|\s)-[a-z]*r[a-z]*(\s|$)/i.test(s) || /--recursive\b/i.test(s)
  const force = /(^|\s)-[a-z]*f[a-z]*(\s|$)/i.test(s) || /--force\b/i.test(s)
  return recursive && force
}

// git operations whose danger depends on a sub-action/pathspec — kept here (rather
// than in the flat list) so the safe forms stay unflagged.
function isDestructiveGit(s) {
  if (!/\bgit\b/i.test(s)) return false
  // checkout that discards uncommitted work: `git checkout -- <path>`,
  // `git checkout .`, `git checkout HEAD -- <path>`. NOT `checkout <branch>`/`-b`.
  if (/\bgit\s+checkout\b/i.test(s) && (/\s--(\s|$)/.test(s) || /\bcheckout\s+\.(\s|$)/i.test(s))) return true
  // `git restore` touching the worktree (default, or --worktree). A pure
  // `--staged` unstage is reversible and stays quiet.
  if (/\bgit\s+restore\b/i.test(s)) {
    const stagedOnly = /--staged\b/i.test(s) && !/--worktree\b/i.test(s)
    if (!stagedOnly) return true
  }
  // rebase rewrites history — except the recovery/no-op subcommands (--abort
  // actually restores the pre-rebase state).
  if (/\bgit\s+rebase\b/i.test(s) && !/--(abort|continue|skip|quit|edit-todo|show-current-patch)\b/i.test(s)) return true
  return false
}

// An unqualified `DELETE FROM <table>` (no WHERE) empties the whole table. A
// targeted `DELETE ... WHERE` is normal and stays quiet.
function isUnqualifiedSqlDelete(s) {
  return /\bdelete\s+from\b/i.test(s) && !/\bwhere\b/i.test(s)
}

// Self-contained irreversible-command patterns. Matched against the raw command.
const PATTERNS = [
  // ---- git: force-ops, ref deletion, history destruction ----
  /--force\b/i,                                       // force-push & "skip the safety confirm" flag (git/aws/prisma…)
  /\bforce-with-lease\b/i,
  /\bgit\s+push\b[^\n|;&]*\s-f(\s|$)/i,               // git push -f
  /\bgit\s+push\b[^\n|;&]*(--delete\b|\s:)/i,         // delete a remote ref: `push origin --delete X` / `push origin :ref`
  /\breset\s+--hard\b/i,
  /\bgit\s+clean\b[^\n|;&]*\s-[a-z]*f/i,              // git clean -fd / -fdx
  /\bgit\s+branch\b[^\n|;&]*\s-D\b/,                  // force-delete branch (case-sensitive -D; -d stays quiet)
  /\bgit\s+branch\b[^\n|;&]*--delete\b[^\n|;&]*--force\b/i,
  /\bgit\s+stash\s+(drop|clear)\b/i,                  // discard stashed work (pop/apply restore → quiet)
  /\bgit\s+reflog\s+expire\b/i,                       // wipe the commit-recovery net
  /\bgit\s+gc\b[^\n|;&]*--prune(=|\s)/i,              // git gc --prune=now/all prunes orphaned commits immediately
  /\bgit\s+tag\s+-d\b/i,                              // delete a tag
  /\bgit\s+update-ref\s+-d\b/i,                       // low-level ref deletion

  // ---- filesystem / data loss ----
  /\bfind\b[^\n|;&]*\s-delete\b/i,                    // mass delete via find
  /\bfind\b[^\n|;&]*-exec\s+(rm|unlink)\b/i,
  /\bshred\b/i,                                       // overwrite-then-delete (unrecoverable by design)
  /\brsync\b[^\n|;&]*--delete/i,                      // mirror-delete wipes dest files absent from src
  /\b(chmod|chown)\b[^\n|;&]*(\s-[a-z]*r[a-z]*(\s|$)|--recursive\b)/i,  // recursive perm/owner change
  /\btruncate\b[^\n|;&]*(-s|--size)[=\s]*0\b/i,       // zero out a file in place
  /\bcrontab\b[^\n|;&]*\s-r\b/i,                      // wipe the user's crontab (no undo)
  // explicit "zero this file" redirects (NOT every `>` — normal writes must stay quiet)
  /(^|[;&|])\s*:\s*>[^>]/,                            // : > file
  /\bcat\s+\/dev\/null\s*>[^>]/i,                     // cat /dev/null > file
  /\becho\s+(""|'')?\s*>[^>]/i,                       // echo > file / echo "" > file (not >>)

  // ---- disk / device destroyers ----
  /\bmkfs(\.|\b)/i,
  /\bdd\b[^\n|;&]*\bof=\/dev\//i,
  />\s*\/dev\/(sd|nvme|disk)/i,

  // ---- SQL / datastore ----
  /\bdrop\s+(table|database|schema|index|view)\b/i,
  /\btruncate\s+table\b/i,
  /\bdropdb\b/i,                                      // postgres dropdb CLI
  /\bdropdatabase\b/i,                               // mongo db.dropDatabase()
  /\bflushall\b/i,                                    // redis FLUSHALL / FLUSHDB
  /\bflushdb\b/i,
  /\bsupabase\s+db\s+reset\b/i,
  /\bprisma\s+migrate\s+reset\b/i,

  // ---- IaC / kubernetes / cloud CLIs / containers ----
  /\b(terraform|pulumi)\b[^\n|;&]*\bdestroy\b/i,
  /\bterraform\b[^\n|;&]*\bapply\b[^\n|;&]*-destroy\b/i,
  /\bvagrant\s+destroy\b/i,
  /\bkubectl\s+delete\b/i,
  /\bhelm\s+(uninstall|delete)\b/i,
  /\baws\s+s3\s+rb\b/i,                               // remove an S3 bucket
  /\baws\s+s3\s+rm\b[^\n|;&]*--recursive\b/i,         // recursively empty an S3 prefix/bucket
  /\baws\s+[\w-]+\s+(delete|terminate|destroy)[\w-]*/i,  // delete-*/terminate-*/destroy on any aws service
  /\bgcloud\b[^\n|;&]*\bdelete\b/i,
  /\baz\b[^\n|;&]*\bdelete\b/i,
  /\b(heroku|flyctl|fly)\b[^\n|;&]*\b(apps:destroy|apps\s+destroy|destroy)\b/i,
  /\bwrangler\b[^\n|;&]*\bdelete\b/i,
  /\bdocker\s+system\s+prune\b[^\n|;&]*\s-[a-z]*a/i,  // docker system prune -a(f)
  /\bdocker\s+volume\s+(rm|prune)\b/i,

  // ---- fork bomb ----
  /:\s*\(\s*\)\s*\{[^}]*\|[^}]*\}/,
]

/** Pull a shell command string out of a hook tool_input (or a raw string). */
export function commandFromInput(input) {
  if (typeof input === 'string') return input
  if (input && typeof input.command === 'string') return input.command
  return ''
}

/**
 * Is this tool invocation an irreversible/destructive command that must never be
 * auto-approved by a blanket "allow for the session" grant?
 *
 * Only shell-style commands carry this risk; file-edit tools (Write/Edit) have no
 * `command` and return false (they're reversible and may be session-scoped).
 */
export function isDangerousCommand(toolName, input) {
  const s = commandFromInput(input)
  if (!s) return false
  return (
    isDestructiveRm(s) ||
    isDestructiveGit(s) ||
    isUnqualifiedSqlDelete(s) ||
    PATTERNS.some((re) => re.test(s))
  )
}

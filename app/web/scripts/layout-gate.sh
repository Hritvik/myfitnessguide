#!/usr/bin/env bash
# The layout gate (wide-layout spec §7): a merge that changes app/web or app/worker
# runs the layout sweep, and a flag blocks it. pre-commit calls this with "merge"
# at pre-merge-commit (a clean merge) and with "commit" at pre-commit, where it only
# acts while a merge is being concluded (MERGE_HEAD exists): git skips
# pre-merge-commit when a merge stops on conflicts. A conflicted merge is gated
# when it brings changes under app/web or app/worker, wherever its conflicts are:
# what the merge brings is MERGE_HEAD's changes since the merge base
# (HEAD...MERGE_HEAD), so a stale branch is judged by its own changes, not by how
# far the target has moved. The hook runs on every commit; this is the filter, not
# pre-commit's files:.
# LAYOUT_GATE_DRY_RUN=1 prints what it would run, for checking the hooks.
# The one sanctioned skip: SKIP=layout-gate-merge,layout-gate-conflicted-merge.
# It skips the gate alone: where TruffleHog runs (the pre-commit stage, so when
# concluding a conflicted merge) it still runs; at pre-merge-commit TruffleHog
# doesn't run at all. Only for a failure the merge didn't cause, after running the
# gate once more, said so in the merge commit's message (README.md, web decision 112).
set -euo pipefail

stage="${1:-merge}"
if [[ "$stage" == "commit" ]]; then
  git rev-parse -q --verify MERGE_HEAD >/dev/null || exit 0
  # Unrelated histories have no merge base: then compare the two tips.
  changed="$(git diff --name-only HEAD...MERGE_HEAD -- app/web app/worker 2>/dev/null \
    || git diff --name-only HEAD MERGE_HEAD -- app/web app/worker)"
  [[ -n "$changed" ]] || exit 0
fi
cd "$(git rev-parse --show-toplevel)"
if [[ -n "${LAYOUT_GATE_DRY_RUN:-}" ]]; then
  echo "Layout gate ($stage): would run npm run test:layout -w @myfitnessguide/web"
  exit 0
fi
echo "Layout gate ($stage): npm run test:layout -w @myfitnessguide/web (up to 10 minutes; a failed run keeps its run directory, findings.json included, and every run copies its summary to \${TMPDIR}/myfitnessguide-e2e-last)"
npm run test:layout -w @myfitnessguide/web

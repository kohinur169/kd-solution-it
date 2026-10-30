// path: docs/final/START_HERE.md
# KD SOLUTION IT - Start Here

## What lives in this repository
- docs/final/FEATURE_LIST.md: the single complete feature list. This is the only scope document.
- docs/final/MASTER_PROMPT.md: the rules every coding chat must follow.
- docs/final/STEP_PLAN_250.md: the project split into 250 small steps, one step per chat.
- docs/final/PRODUCTION_CHECKLIST.md: accounts, environment variables, email domain, payment live readiness and the go-live sequence needed to run the finished project as a business.
- docs/final/HANDOFF_TEMPLATE.md: the fixed template every chat copies to docs/handoffs/STEP_NNN_COMPLETED.md and fills completely.
- docs/handoffs/: one completion file per finished STEP, created by the chat that finished it.

## How the owner runs the build
1. Keep these documents inside the GitHub repository that will hold the project code.
2. Open a new coding chat with this repository selected.
3. Write only one line in that chat: Implement STEP 001.
4. The agent reads FEATURE_LIST.md, MASTER_PROMPT.md and STEP_PLAN_250.md from the
   repository by itself, verifies the full plan and the complete project scope, implements
   only STEP 001, runs typecheck and lint, commits, pushes, and writes
   docs/handoffs/STEP_001_COMPLETED.md.
5. Open the next chat with the same repository selected and write: Implement STEP 002.
6. Continue in order up to STEP 250. Never skip a step and never run two steps in one chat.

## Why no long instruction needs to be pasted
The repository is selected in the chat, so the agent has direct access to the feature list,
the master rules and the step plan. The single line "Implement STEP NNN" is enough because
MASTER_PROMPT.md instructs the agent to read everything from the repository, check the
previous handoff, stay inside the scope of that one STEP, and leave a handoff for the next chat.

## Golden rules for the whole build
- FEATURE_LIST.md is the only scope. If a STEP line and the feature list ever differ,
  the feature list wins.
- One chat, one STEP, one commit, one handoff file.
- package.json changes happen only through package requests written in handoff files.
- Migrations are append-only and are never edited after they are committed.

// path: scripts/README.md
# scripts/

Owner: STEP 001.

Dependency free Node scripts executed through npm scripts. They run offline so a
verification never fails because a third party registry is unreachable.

| Script | npm command | Purpose |
| --- | --- | --- |
| verify-structure.mjs | npm run check:structure | Verifies the canonical tree from config/structure.json, the path comment on the first line of every source file, and the absence of forbidden markers |

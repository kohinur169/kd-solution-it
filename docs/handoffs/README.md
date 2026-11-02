// path: docs/handoffs/README.md
# docs/handoffs/

One completed handoff file per finished STEP, named STEP_NNN_COMPLETED.md and copied from
docs/final/HANDOFF_TEMPLATE.md with every field filled. A STEP is not complete while its
handoff file is missing from the same commit that contains its code.

## A note on the commit hashes of STEPs 001-038

Every handoff names the commit its STEP was committed in. The handoffs of STEPs 021-026 name
commits (`0365d62`, `28696f9`, `6d6023a`, `c456688`, `b25ff20`, `81de8c0`) that no longer exist as
objects in this repository: the work of STEPs 001-038 arrived here in one root commit,
`1dfd803` ("Merge pull request #1 from kohinur169/arena/aa2e219d-kd-solution-it"), which carries no
parent history. The hashes were accurate when they were written and the code they describe is in the
tree; the objects behind them are what the flattening removed. The handoff of every STEP from 039 on
names a commit this repository holds.

A repair session should therefore read "the commit it names" as "the commit it was written against",
and check the code against the tree rather than against `git cat-file`.

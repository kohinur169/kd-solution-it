// path: config/README.md
# config/

Owner: STEP 001-011 (foundation configuration).

Typed application configuration: business limits, provider defaults, retention and
pagination limits, feature flags and the canonical structure manifest in structure.json.

Rules:
- Configuration is typed and frozen at module load, never read from a raw environment
  variable outside the validated environment schema.
- Secrets never live in this folder; only names and non secret defaults do.
- structure.json is read by scripts/verify-structure.mjs on every verification run.

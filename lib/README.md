// path: lib/README.md
# lib/

Owner: STEP 001 creates the folder; each foundation and feature STEP owns its library.

Foundation libraries that other layers depend on: validated environment schema, typed
configuration, English string catalog, structured logging, error format, security helpers,
storage adapters, payment core and adapters, tax, email and API clients.

Rules:
- A library never imports from app/ or services/; dependencies point inward.
- Every external call is wrapped with timeout, retry policy and structured logging.
- Every file starts with its path comment and has no side effect at import time unless
  that side effect is the module's documented purpose.

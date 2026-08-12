# Offline DSPy optimization for compaction

DSPy is an offline compiler for the compaction prompt, not a runtime authority. The production TypeScript path remains responsible for cut-point selection, timeout and cancellation, source provenance, requirement preservation, identifier validation, session persistence, and the final accept-or-reject decision.

An optimization dataset should contain source conversations, exact user constraints, pending actions, supported identifiers, prohibited claims, and continuation tasks. The metric must fail closed on any dropped required constraint, unsupported PR or commit identifier, nonterminal model response, or false completion claim. Compression ratio and readability are scored only after these correctness gates pass.

The recommended first optimizer is MIPROv2 over a versioned prompt-and-demonstration artifact. GEPA is appropriate only after the deterministic validator can return stable, specific feedback such as an omitted requirement or unsupported identifier. Compiled artifacts are exported as reviewable JSON with the dataset digest, metric version, optimizer settings, and held-out results; pickle artifacts and runtime Python subprocesses are not accepted.

Promotion requires zero hard-gate violations, full required-constraint recall, pending-action recall no worse than the baseline, improved held-out continuation quality, and no material regression in latency or token cost. The built-in prompt remains the rollback artifact, and every optimized candidate still passes the same runtime safety validator before a compaction entry can be persisted.

# Compaction safety contract

Compaction is lossy by design, so model quality is not treated as a safety boundary.

The runtime rejects empty, truncated, aborted, errored, or tool-use summary responses. It also rejects PR numbers and commit identifiers that are absent from the source context. Explicit user constraints are extracted before summarization and appended to the checkpoint in a deterministic ledger, which is carried across later compactions and recorded in `CompactionEntry.details.safety`.

DSPy belongs outside the runtime path. It may optimize summarization instructions and demonstrations against a versioned evaluation set, but an optimized artifact must still pass the same deterministic validation contract before deployment. Cut-point selection, timeout and cancellation, source provenance, requirement preservation, session persistence, and acceptance or rejection remain TypeScript runtime responsibilities.

A DSPy candidate is eligible for promotion only when it has zero unsupported identifiers and nonterminal outputs, preserves all required constraints, does not reduce pending-action recall, and improves continuation quality on a held-out session set. The default prompt remains the fallback artifact.

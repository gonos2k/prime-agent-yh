from pathlib import Path
from textwrap import dedent


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement target, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


session = "packages/coding-agent/src/core/agent-session.ts"
replace_once(
    session,
    "\t\tconst hadPostCompactionContinue = this._postCompactionContinuationScheduled;\n"
    "\t\tthis._disconnectFromAgent();\n"
    "\t\tif (!options.skipAbort) await this.abort();\n"
    "\t\tlet didCompact = false;",
    "\t\tconst hadPostCompactionContinue = this._postCompactionContinuationScheduled;\n"
    "\t\t// Public compaction owns only the suspension it creates. Preserve a\n"
    "\t\t// pre-existing suspension, and use the pump epoch so a later external\n"
    "\t\t// abort/restart request cannot be accidentally undone in finally.\n"
    "\t\tconst ownsInputPumpSuspension = !options.skipAbort && !this._sessionInputPumpSuspended;\n"
    "\t\tlet ownedInputPumpEpoch: number | undefined;\n"
    "\t\tthis._disconnectFromAgent();\n"
    "\t\tif (!options.skipAbort) {\n"
    "\t\t\tawait this.abort();\n"
    "\t\t\tif (ownsInputPumpSuspension) ownedInputPumpEpoch = this._sessionInputPumpEpoch;\n"
    "\t\t}\n"
    "\t\tlet didCompact = false;",
)

replace_once(
    session,
    "\t\t\tresolveCompactionOperation();\n"
    "\t\t\tthis._scheduleSessionInputPump();\n"
    "\t\t\tif (didCompact) {",
    "\t\t\tresolveCompactionOperation();\n"
    "\t\t\tif (\n"
    "\t\t\t\townedInputPumpEpoch !== undefined &&\n"
    "\t\t\t\tthis._sessionInputPumpSuspended &&\n"
    "\t\t\t\tthis._sessionInputPumpEpoch === ownedInputPumpEpoch &&\n"
    "\t\t\t\t!this._disposed &&\n"
    "\t\t\t\t!this._disposing\n"
    "\t\t\t) {\n"
    "\t\t\t\tthis._sessionInputPumpSuspended = false;\n"
    "\t\t\t\tthis._notifySessionInputCheckpointChange();\n"
    "\t\t\t}\n"
    "\t\t\tthis._scheduleSessionInputPump();\n"
    "\t\t\tif (didCompact) {",
)

compaction_test = "packages/coding-agent/test/suite/agent-session-compaction.test.ts"
test = dedent(
    '''

    \tit("restores only the scheduler suspension owned by public manual compaction", async () => {
    \t\tconst harness = await createHarness({
    \t\t\tsettings: { compaction: { keepRecentTokens: 1 } },
    \t\t\textensionFactories: [
    \t\t\t\t(pi) => {
    \t\t\t\t\tpi.on("session_before_compact", async (event) => ({
    \t\t\t\t\t\tcompaction: {
    \t\t\t\t\t\t\tsummary: "scheduler restore summary",
    \t\t\t\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,
    \t\t\t\t\t\t\ttokensBefore: event.preparation.tokensBefore,
    \t\t\t\t\t\t\tdetails: {},
    \t\t\t\t\t\t},
    \t\t\t\t\t}));
    \t\t\t\t},
    \t\t\t],
    \t\t});
    \t\tharnesses.push(harness);
    \t\tawait harness.session.prompt("one");
    \t\tawait harness.session.prompt("two");
    \t\tconst internals = harness.session as unknown as {
    \t\t\t_sessionInputPumpSuspended: boolean;
    \t\t};

    \t\texpect(internals._sessionInputPumpSuspended).toBe(false);
    \t\tawait harness.session.compact();
    \t\texpect(internals._sessionInputPumpSuspended).toBe(false);
    \t});
    '''
)
replace_once(
    compaction_test,
    '\n\tit("bounds a stuck post-commit extension hook and preserves the committed compaction", async () => {',
    test + '\n\tit("bounds a stuck post-commit extension hook and preserves the committed compaction", async () => {',
)

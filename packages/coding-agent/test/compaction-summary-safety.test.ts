import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	appendPreservedUserRequirements,
	buildCompactionSafetyDetails,
	buildSummarySourceText,
	CompactionSummarySafetyError,
	collectPreservedUserRequirements,
	extractSummaryIdentifiers,
	validateSummaryResponse,
	validateSummaryText,
} from "../src/core/compaction/summary-safety.js";

const VALID_HISTORY_SUMMARY = `## Goal
Continue the requested implementation.

## Constraints & Preferences
- Keep the change small.

## Progress
### Done
- [x] Inspected the current implementation.

### In Progress
- [ ] Add the safety contract.

### Blocked
- (none)

## Key Decisions
- **Fail closed**: reject unsafe summaries.

## Next Steps
1. Run focused tests.

## Critical Context
- Preserve exact identifiers.`;

const VALID_TURN_PREFIX_SUMMARY = `## Original Request
Implement the requested fix.

## Early Progress
- Inspected the relevant code.

## Context for Suffix
- Continue from the retained suffix.`;

function response(stopReason: AssistantMessage["stopReason"], text = VALID_HISTORY_SUMMARY): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

function expectSafetyError(action: () => unknown, code: CompactionSummarySafetyError["code"]): void {
	try {
		action();
		throw new Error("Expected CompactionSummarySafetyError");
	} catch (error) {
		expect(error).toBeInstanceOf(CompactionSummarySafetyError);
		expect((error as CompactionSummarySafetyError).code).toBe(code);
	}
}

describe("compaction summary response safety", () => {
	it("accepts a complete normally terminated history summary", () => {
		expect(validateSummaryResponse(response("stop"), "history", "", "Summarization")).toBe(VALID_HISTORY_SUMMARY);
	});

	it("accepts the turn-prefix contract", () => {
		expect(validateSummaryResponse(response("stop", VALID_TURN_PREFIX_SUMMARY), "turn-prefix", "", "Prefix")).toBe(
			VALID_TURN_PREFIX_SUMMARY,
		);
	});

	it("rejects length-truncated output", () => {
		expectSafetyError(
			() => validateSummaryResponse(response("length"), "history", "", "Summarization"),
			"truncated-response",
		);
	});

	it.each(["aborted", "error", "toolUse"] as const)("rejects %s output", (stopReason) => {
		expectSafetyError(
			() => validateSummaryResponse(response(stopReason), "history", "", "Summarization"),
			"non-terminal-response",
		);
	});

	it("rejects whitespace-only output", () => {
		expectSafetyError(
			() => validateSummaryResponse(response("stop", "  \n\t"), "history", "", "Summarization"),
			"empty-summary",
		);
	});

	it("rejects a summary missing a required section", () => {
		expectSafetyError(() => validateSummaryText("## Goal\nOnly a goal", "history", ""), "missing-section");
	});
});

describe("compaction summary identifier provenance", () => {
	it("rejects a PR number not present in the source", () => {
		expectSafetyError(
			() => validateSummaryText(`${VALID_HISTORY_SUMMARY}\n- PR #918 completed.`, "history", "PR #17"),
			"invented-identifier",
		);
	});

	it("rejects a commit SHA not present in the source", () => {
		expectSafetyError(
			() => validateSummaryText(`${VALID_HISTORY_SUMMARY}\n- Commit abc1234 applied.`, "history", "Commit def5678"),
			"invented-identifier",
		);
	});

	it("accepts an abbreviated source commit and exact PR", () => {
		const source = "Merged PR #17 at c125bbced63ee2631ba67a653b770e4c1ffa6e6c";
		const summary = `${VALID_HISTORY_SUMMARY}\n- PR #17 is at c125bbce.`;
		expect(validateSummaryText(summary, "history", source)).toBe(summary);
	});

	it("extracts deterministic sorted identifiers", () => {
		expect(extractSummaryIdentifiers("PR #12 then PR #3; commits abc1234 and def5678")).toEqual({
			commitShas: ["abc1234", "def5678"],
			pullRequests: [3, 12],
		});
	});
});

describe("deterministic user-requirement pinning", () => {
	it("pins explicit English and Korean constraints plus custom instructions", () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: "Implement the fix.\nDo not change the public API.\n코드는 단순하고 명료하게 유지.",
				timestamp: 1,
			},
		];

		expect(collectPreservedUserRequirements(messages, undefined, "Preserve PR #17 verbatim.")).toEqual([
			"Preserve PR #17 verbatim.",
			"Do not change the public API.",
			"코드는 단순하고 명료하게 유지.",
		]);
	});

	it("carries prior pinned requirements forward without duplication", () => {
		const previous = appendPreservedUserRequirements(VALID_HISTORY_SUMMARY, ["Never push directly to main."]);
		const messages: AgentMessage[] = [{ role: "user", content: "Never push directly to main.", timestamp: 1 }];
		expect(collectPreservedUserRequirements(messages, previous)).toEqual(["Never push directly to main."]);
	});

	it("replaces a generated trailing requirement section with the deterministic ledger", () => {
		const generated = appendPreservedUserRequirements(VALID_HISTORY_SUMMARY, ["invented"]);
		const result = appendPreservedUserRequirements(generated, ["Do not change the API."]);
		expect(result).not.toContain("invented");
		expect(result).toContain('<requirement id="r1">\nDo not change the API.\n</requirement>');
	});

	it("records the exact preservation and identifier evidence in details", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "Keep PR #17 and commit c125bbce unchanged.", timestamp: 1 },
		];
		const requirements = collectPreservedUserRequirements(messages);
		const summary = appendPreservedUserRequirements(`${VALID_HISTORY_SUMMARY}\n- PR #17 at c125bbce.`, requirements);
		const details = buildCompactionSafetyDetails(summary, messages, requirements);

		expect(details).toEqual({
			version: 1,
			preservedUserRequirements: ["Keep PR #17 and commit c125bbce unchanged."],
			sourceIdentifiers: { commitShas: ["c125bbce"], pullRequests: [17] },
			summaryIdentifiers: { commitShas: ["c125bbce"], pullRequests: [17] },
		});
		expect(buildSummarySourceText(messages)).toContain("PR #17");
	});
});

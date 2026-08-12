import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	CompactionSummarySafetyError,
	compact,
	createFileOps,
	generateSummary,
} from "../src/core/compaction/index.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "text",
			text: `## Goal
Test summary.

## Constraints & Preferences
- (none)

## Progress
### Done
- [x] Read the source conversation.

### In Progress
- [ ] Continue the test.

### Blocked
- (none)

## Key Decisions
- **Validation**: preserve the required section contract.

## Next Steps
1. Return the summary.

## Critical Context
- (none)`,
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("rejects a length-truncated model response", async () => {
		completeSimpleMock.mockResolvedValue({ ...mockSummaryResponse, stopReason: "length" });

		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).rejects.toMatchObject({
			name: CompactionSummarySafetyError.name,
			code: "truncated-response",
		});
	});

	it("rejects an unsupported PR identifier", async () => {
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			content: [
				{
					type: "text",
					text: `${mockSummaryResponse.content[0]?.type === "text" ? mockSummaryResponse.content[0].text : ""}\n- PR #918 completed.`,
				},
			],
		});

		await expect(
			generateSummary(
				[{ role: "user", content: "Continue work on PR #17.", timestamp: Date.now() }],
				createModel(false),
				2000,
				"test-key",
			),
		).rejects.toMatchObject({
			name: CompactionSummarySafetyError.name,
			code: "invented-identifier",
		});
	});

	it("pins exact user requirements outside the lossy model summary", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [
				{
					role: "user",
					content: "Implement the change.\nDo not change the public API.",
					timestamp: Date.now(),
				},
			],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 10_000,
			fileOps: createFileOps(),
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 },
		};

		const result = await compact(preparation, createModel(false), "test-key");

		expect(result.summary).toContain('<requirement id="r1">\nDo not change the public API.\n</requirement>');
		expect(result.details).toMatchObject({
			safety: {
				version: 1,
				preservedUserRequirements: ["Do not change the public API."],
			},
		});
	});
});

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export type CompactionSummaryKind = "history" | "turn-prefix";

export type CompactionSummarySafetyErrorCode =
	| "non-terminal-response"
	| "truncated-response"
	| "empty-summary"
	| "missing-section"
	| "invalid-section-order"
	| "invented-identifier"
	| "requirement-budget-exceeded";

export class CompactionSummarySafetyError extends Error {
	constructor(
		readonly code: CompactionSummarySafetyErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CompactionSummarySafetyError";
	}
}

export interface SummaryIdentifiers {
	commitShas: string[];
	pullRequests: number[];
}

export interface CompactionSafetyDetails {
	version: 1;
	preservedUserRequirements: string[];
	sourceIdentifiers: SummaryIdentifiers;
	summaryIdentifiers: SummaryIdentifiers;
}

const HISTORY_REQUIRED_SECTIONS = [
	"## Goal",
	"## Constraints & Preferences",
	"## Progress",
	"## Next Steps",
	"## Critical Context",
] as const;

const TURN_PREFIX_REQUIRED_SECTIONS = [
	"## Original Request",
	"## Early Progress",
	"## Context for Suffix",
] as const;

const PRESERVED_REQUIREMENTS_HEADING = "## Preserved User Requirements";
const MAX_PRESERVED_REQUIREMENTS = 64;
const MAX_PRESERVED_REQUIREMENT_CHARS = 12_000;

const HARD_REQUIREMENT_PATTERN =
	/(?:\bmust(?:\s+not)?\b|\bdo not\b|\bdon't\b|\bnever\b|\bpreserve\b|\bkeep\b.{0,80}\b(?:exact|unchanged|same)\b|\bexclude\b|\bwithout\b|반드시|절대|금지|하지\s*마|하지\s*않|제외|유지|그대로|변경하지|왜곡하지|기준(?:으로|은|을)?|필수|단순|명료|간결|직관)/iu;

function extractUserText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;

	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function requirementCandidates(text: string): string[] {
	const candidates: string[] = [];
	for (const line of text.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.length <= 2_000) {
			candidates.push(trimmed);
			continue;
		}

		for (const sentence of trimmed.split(/(?<=[.!?。！？])\s+/u)) {
			const candidate = sentence.trim();
			if (candidate) candidates.push(candidate);
		}
	}
	return candidates;
}

function requirementKey(requirement: string): string {
	return requirement.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function extractPreviousRequirements(previousSummary?: string): string[] {
	if (!previousSummary) return [];
	const sectionIndex = previousSummary.lastIndexOf(PRESERVED_REQUIREMENTS_HEADING);
	if (sectionIndex < 0) return [];

	const section = previousSummary.slice(sectionIndex + PRESERVED_REQUIREMENTS_HEADING.length);
	const requirements: string[] = [];
	const pattern = /<requirement id="[^"]+">\n([\s\S]*?)\n<\/requirement>/gu;
	for (const match of section.matchAll(pattern)) {
		const requirement = match[1]?.replaceAll("<\\/requirement>", "</requirement>").trim();
		if (requirement) requirements.push(requirement);
	}
	return requirements;
}

/**
 * Collect exact user constraints outside the lossy model summary.
 *
 * The extractor is intentionally conservative: it only pins explicit modal,
 * negative, preservation, or implementation-style requirements. Existing
 * pinned requirements are carried forward verbatim across later compactions.
 */
export function collectPreservedUserRequirements(
	messages: AgentMessage[],
	previousSummary?: string,
	customInstructions?: string,
): string[] {
	const requirements: string[] = [];
	const seen = new Set<string>();
	let totalChars = 0;

	const add = (requirement: string): void => {
		const trimmed = requirement.trim();
		if (!trimmed) return;
		const key = requirementKey(trimmed);
		if (seen.has(key)) return;

		if (
			requirements.length >= MAX_PRESERVED_REQUIREMENTS ||
			totalChars + trimmed.length > MAX_PRESERVED_REQUIREMENT_CHARS
		) {
			throw new CompactionSummarySafetyError(
				"requirement-budget-exceeded",
				"Compaction would exceed the deterministic user-requirement preservation budget",
			);
		}

		seen.add(key);
		requirements.push(trimmed);
		totalChars += trimmed.length;
	};

	for (const requirement of extractPreviousRequirements(previousSummary)) add(requirement);
	if (customInstructions) add(customInstructions);

	for (const message of messages) {
		const text = extractUserText(message);
		if (!text) continue;
		for (const candidate of requirementCandidates(text)) {
			if (HARD_REQUIREMENT_PATTERN.test(candidate)) add(candidate);
		}
	}

	return requirements;
}

function stripTrailingPreservedRequirements(summary: string): string {
	const sectionIndex = summary.lastIndexOf(PRESERVED_REQUIREMENTS_HEADING);
	if (sectionIndex < 0) return summary.trimEnd();
	return summary.slice(0, sectionIndex).trimEnd();
}

/** Append exact requirements after the generated summary and deterministic file ledger. */
export function appendPreservedUserRequirements(summary: string, requirements: string[]): string {
	const base = stripTrailingPreservedRequirements(summary);
	if (requirements.length === 0) return base;

	const blocks = requirements.map((requirement, index) => {
		const escaped = requirement.replaceAll("</requirement>", "<\\/requirement>");
		return `<requirement id="r${index + 1}">\n${escaped}\n</requirement>`;
	});

	return `${base}\n\n${PRESERVED_REQUIREMENTS_HEADING}\n${blocks.join("\n")}`;
}

/** Build a source corpus for deterministic identifier validation. */
export function buildSummarySourceText(
	messages: AgentMessage[],
	previousSummary?: string,
	customInstructions?: string,
): string {
	return [JSON.stringify(messages), previousSummary ?? "", customInstructions ?? ""].join("\n");
}

export function extractSummaryIdentifiers(text: string): SummaryIdentifiers {
	const commitShas = new Set<string>();
	const pullRequests = new Set<number>();

	const commitPattern = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/giu;
	for (const match of text.matchAll(commitPattern)) {
		commitShas.add(match[0].toLocaleLowerCase());
	}

	const pullRequestPattern = /\b(?:PR|pull\s+request)\s*#\s*(\d+)\b/giu;
	for (const match of text.matchAll(pullRequestPattern)) {
		const number = Number.parseInt(match[1] ?? "", 10);
		if (Number.isSafeInteger(number)) pullRequests.add(number);
	}

	return {
		commitShas: [...commitShas].sort(),
		pullRequests: [...pullRequests].sort((a, b) => a - b),
	};
}

function validateSections(summary: string, kind: CompactionSummaryKind): void {
	const requiredSections = kind === "history" ? HISTORY_REQUIRED_SECTIONS : TURN_PREFIX_REQUIRED_SECTIONS;
	const lines = summary.split(/\r?\n/u).map((line) => line.trim());
	let previousIndex = -1;

	for (const section of requiredSections) {
		const index = lines.indexOf(section);
		if (index < 0) {
			throw new CompactionSummarySafetyError(
				"missing-section",
				`Compaction summary is missing required section: ${section}`,
			);
		}
		if (index <= previousIndex) {
			throw new CompactionSummarySafetyError(
				"invalid-section-order",
				`Compaction summary section is out of order: ${section}`,
			);
		}
		previousIndex = index;
	}
}

function commitIsSupported(commit: string, sourceCommits: string[]): boolean {
	return sourceCommits.some((sourceCommit) => sourceCommit.startsWith(commit) || commit.startsWith(sourceCommit));
}

function validateIdentifiers(summary: string, sourceText: string): void {
	const source = extractSummaryIdentifiers(sourceText);
	const generated = extractSummaryIdentifiers(summary);

	for (const commit of generated.commitShas) {
		if (!commitIsSupported(commit, source.commitShas)) {
			throw new CompactionSummarySafetyError(
				"invented-identifier",
				`Compaction summary introduced unsupported commit identifier: ${commit}`,
			);
		}
	}

	const sourcePullRequests = new Set(source.pullRequests);
	for (const pullRequest of generated.pullRequests) {
		if (!sourcePullRequests.has(pullRequest)) {
			throw new CompactionSummarySafetyError(
				"invented-identifier",
				`Compaction summary introduced unsupported PR identifier: PR #${pullRequest}`,
			);
		}
	}
}

export function validateSummaryText(summary: string, kind: CompactionSummaryKind, sourceText: string): string {
	const trimmed = summary.trim();
	if (!trimmed) {
		throw new CompactionSummarySafetyError("empty-summary", "Compaction summary contained no text");
	}

	validateSections(trimmed, kind);
	validateIdentifiers(trimmed, sourceText);
	return trimmed;
}

/** Accept only a complete, normally terminated, source-supported summary. */
export function validateSummaryResponse(
	response: AssistantMessage,
	kind: CompactionSummaryKind,
	sourceText: string,
	label: string,
): string {
	if (response.stopReason !== "stop") {
		const code = response.stopReason === "length" ? "truncated-response" : "non-terminal-response";
		const detail = response.errorMessage ? `: ${response.errorMessage}` : "";
		throw new CompactionSummarySafetyError(
			code,
			`${label} did not terminate normally (${response.stopReason})${detail}`,
		);
	}

	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");

	return validateSummaryText(text, kind, sourceText);
}

export function buildCompactionSafetyDetails(
	summary: string,
	messages: AgentMessage[],
	preservedUserRequirements: string[],
	previousSummary?: string,
	customInstructions?: string,
): CompactionSafetyDetails {
	const sourceText = buildSummarySourceText(messages, previousSummary, customInstructions);
	return {
		version: 1,
		preservedUserRequirements: [...preservedUserRequirements],
		sourceIdentifiers: extractSummaryIdentifiers(sourceText),
		summaryIdentifiers: extractSummaryIdentifiers(summary),
	};
}

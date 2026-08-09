import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRecoveryJournal, createCommandIdempotencyKey } from "../src/modes/daemon/command-recovery-journal.js";

describe("CommandRecoveryJournal", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-command-journal-"));
		roots.push(root);
		return join(root, "commands.jsonl");
	}

	function receivedRecord(clientId = "client-a", commandId = "command-a", commandType = "prompt") {
		return {
			version: 1,
			type: "received" as const,
			key: createCommandIdempotencyKey(clientId, commandId),
			clientId,
			commandId,
			commandType,
			recordedAt: new Date().toISOString(),
		};
	}

	it("marks received commands uncertain instead of replaying them", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("rejects reusing one idempotency key for a different command type", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });

		expect(() => journal.lookup("client-a", "command-a", "shutdown")).toThrow(
			/already received as prompt and cannot be reused as shutdown/,
		);
		expect(() => journal.begin("client-a", "command-a", "shutdown")).toThrow(
			/already received as prompt and cannot be reused as shutdown/,
		);
		expect(journal.lookup("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("looks up prior commands without inserting new receipts", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.lookup("client-a", "missing")).toBeUndefined();
		expect(journal.begin("client-a", "pending", "prompt")).toEqual({ status: "new" });
		expect(journal.lookup("client-a", "pending")).toEqual({ status: "pending" });
	});

	it("does not collide when client and command ids contain separators", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client:a", "command", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client", "a:command", "prompt")).toEqual({ status: "new" });
	});

	it("returns a durable stored result for a repeated idempotency key", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({
			status: "complete",
			response: {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: true,
			},
		});
	});

	it("round-trips a UTF-8 failure response without replacement characters", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: false,
			error: "레이더 자료동화 오류",
		});

		expect(new CommandRecoveryJournal(path).lookup("client-a", "command-a", "prompt")).toEqual({
			status: "complete",
			response: {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: false,
				error: "레이더 자료동화 오류",
			},
		});
	});

	it("requires durable response metadata to match the received command", () => {
		const journal = new CommandRecoveryJournal(createPath());
		journal.begin("client-a", "command-a", "prompt");

		expect(() =>
			journal.recordResult("client-a", "command-a", {
				id: "different-id",
				type: "response",
				command: "prompt",
				success: true,
			}),
		).toThrow(/does not match received command id/);
		expect(() =>
			journal.recordResult("client-a", "command-a", {
				id: "command-a",
				type: "response",
				command: "shutdown",
				success: true,
			}),
		).toThrow(/does not match received command type/);
		expect(journal.lookup("client-a", "command-a")).toEqual({ status: "pending" });
	});

	it("accepts a structurally identical repeated result but rejects a conflicting replacement", () => {
		const journal = new CommandRecoveryJournal(createPath());
		journal.begin("client-a", "command-a", "prompt");
		const response = {
			id: "command-a",
			type: "response" as const,
			command: "prompt" as const,
			success: true as const,
		};
		journal.recordResult("client-a", "command-a", response);
		const sameResponseDifferentKeyOrder = {
			success: true as const,
			command: "prompt" as const,
			type: "response" as const,
			id: "command-a",
		};
		expect(() => journal.recordResult("client-a", "command-a", sameResponseDifferentKeyOrder)).not.toThrow();
		expect(() =>
			journal.recordResult("client-a", "command-a", {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: false,
				error: "conflicting result",
			}),
		).toThrow(/conflicting response/);
	});

	it("repairs a truncated final append before accepting later records", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		appendFileSync(path, '{"version":1,"type":"result"');

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
		restored.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		expect(new CommandRecoveryJournal(path).begin("client-a", "command-a", "prompt")).toEqual({
			status: "complete",
			response: {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: true,
			},
		});
	});

	it("repairs an invalid UTF-8 sequence in the unterminated final append", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		const verifiedPrefix = readFileSync(path);
		appendFileSync(path, Buffer.from([0xe2, 0x82]));

		const restored = new CommandRecoveryJournal(path);

		expect(restored.lookup("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
		expect(readFileSync(path)).toEqual(verifiedPrefix);
	});

	it("restores the missing line feed after a complete final record", () => {
		const path = createPath();
		writeFileSync(path, JSON.stringify(receivedRecord()));

		const restored = new CommandRecoveryJournal(path);
		expect(restored.lookup("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);

		restored.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});
		expect(new CommandRecoveryJournal(path).lookup("client-a", "command-a", "prompt")?.status).toBe("complete");
	});

	it("fails closed on invalid UTF-8 in a completed record", () => {
		const path = createPath();
		writeFileSync(
			path,
			Buffer.concat([
				Buffer.from('{"version":1,"type":"received","key":"', "utf8"),
				Buffer.from([0xff]),
				Buffer.from('","recordedAt":"now"}\n', "utf8"),
			]),
		);

		expect(() => new CommandRecoveryJournal(path)).toThrow(/line 1: record is not valid UTF-8/);
	});

	it("fails closed on malformed journal data before the final partial append", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		appendFileSync(path, "{not valid json}\n");

		expect(() => new CommandRecoveryJournal(path)).toThrow(/line 2: malformed JSON/);
	});

	it("fails closed when a record omits recordedAt", () => {
		const path = createPath();
		const { recordedAt: _recordedAt, ...record } = receivedRecord();
		writeFileSync(path, `${JSON.stringify(record)}\n`);

		expect(() => new CommandRecoveryJournal(path)).toThrow(/missing type\/key\/recordedAt/);
	});

	it("fails closed when a received record carries a non-canonical key", () => {
		const path = createPath();
		appendFileSync(
			path,
			`${JSON.stringify({
				...receivedRecord(),
				key: createCommandIdempotencyKey("other-client", "other-command"),
			})}\n`,
		);

		expect(() => new CommandRecoveryJournal(path)).toThrow(/non-canonical key/);
	});

	it("fails closed when a result has no preceding durable receipt", () => {
		const path = createPath();
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				type: "result",
				key: createCommandIdempotencyKey("client-a", "command-a"),
				response: {
					id: "command-a",
					type: "response",
					command: "prompt",
					success: true,
				},
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		expect(() => new CommandRecoveryJournal(path)).toThrow(/no preceding received record/);
	});

	it("fails closed when a result response omits success", () => {
		const path = createPath();
		const receipt = receivedRecord();
		writeFileSync(
			path,
			`${JSON.stringify(receipt)}\n${JSON.stringify({
				version: 1,
				type: "result",
				key: receipt.key,
				response: {
					id: "command-a",
					type: "response",
					command: "prompt",
				},
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		expect(() => new CommandRecoveryJournal(path)).toThrow(/result response has an invalid envelope/);
	});

	it("fails closed when a failed response omits its error", () => {
		const path = createPath();
		const receipt = receivedRecord();
		writeFileSync(
			path,
			`${JSON.stringify(receipt)}\n${JSON.stringify({
				version: 1,
				type: "result",
				key: receipt.key,
				response: {
					id: "command-a",
					type: "response",
					command: "prompt",
					success: false,
				},
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		expect(() => new CommandRecoveryJournal(path)).toThrow(/failed result response is missing an error/);
	});

	it("rejects acknowledging an uncertain command", () => {
		const journal = new CommandRecoveryJournal(createPath());
		journal.begin("client-a", "command-a", "prompt");

		expect(() => journal.acknowledge("client-a", "command-a")).toThrow(/before its result is durable/);
		expect(journal.lookup("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("fails closed when recovery finds an acknowledgement without a durable result", () => {
		const path = createPath();
		const receipt = receivedRecord();
		writeFileSync(
			path,
			`${JSON.stringify(receipt)}\n${JSON.stringify({
				version: 1,
				type: "acknowledged",
				key: receipt.key,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		expect(() => new CommandRecoveryJournal(path)).toThrow(/acknowledged record has no preceding durable result/);
	});

	it("durably removes acknowledged results", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});
		journal.acknowledge("client-a", "command-a");

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
	});
});

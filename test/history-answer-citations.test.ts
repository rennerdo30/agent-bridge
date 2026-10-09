import { expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { answerHistory, type HistoryAnswerDependencies } from "../src/core/history-answer.js";
import type { HistoryHit, HistoryResult } from "../src/core/history-query.js";
import { nullLogger } from "../src/core/logger.js";

// AB-234: durable:<n> and question:<id> sources are real history ids and must count as citations.
const hit = (id: string, kind: HistoryHit["kind"]): HistoryHit => ({ id, kind, agent: "codex", at: 1, snippet: "walnut", link: "", sourceLink: `/api/history/${id}`, message: null, job: null, run: null, session: null, cursor: null });
const result: HistoryResult = { engine: "fts5", hits: [hit("durable:123", "transcript"), hit("question:6f1c", "question")] };
const deps = (text: string): HistoryAnswerDependencies => ({
  available: () => true,
  usage: async (agent) => ({ agent, lines: [], limits: [], maxUsedPercent: 10 }),
  models: async (agent) => ({ agent, models: ["gpt-6-luna"], defaultModel: null, lines: [] }),
  costs: async () => [],
  run: vi.fn(async () => text),
});

it("accepts answers citing durable: and question: sources", async () => {
  const answer = await answerHistory("walnut", result, DEFAULT_CONFIG, "/unused", nullLogger, deps("Walnut was decided. [durable:123] [question:6f1c]"));
  expect(answer.error).toBeUndefined();
  expect(answer.text).toContain("[durable:123]");
});

it("rejects an invented citation of any kind, also beside a valid one", async () => {
  const answer = await answerHistory("walnut", result, DEFAULT_CONFIG, "/unused", nullLogger, deps("Walnut. [durable:123] [durable:999]"));
  expect(answer.error).toMatch(/did not cite/);
});

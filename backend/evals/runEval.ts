import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHistoryAssistantMessage,
  buildHistoryUserMessage,
  buildInterviewSystemPrompt,
  buildInterviewUserPrompt,
  type PromptMode,
} from "../src/prompts/interviewPrompt.js";

/**
 * Agent-only offline eval script.
 *
 * How to use with Cursor / Claude / Antigravity built-in agent chat:
 * 1. Ask the agent to read this file and `datasets/interview-answer.dataset.json`.
 * 2. Ask the agent to fill AGENT_ANSWERS below. Do not call Anthropic/API.
 * 3. Run: npm run eval
 * 4. Results are written to evals/results/eval-*.json.
 *
 * Keep this file simple on purpose: one script + one dataset.
 */

const AGENT_NAME = "fill-this-agent-name";

const AGENT_ANSWERS: AgentAnswer[] = [
  // Agent chat fills this array, one item per dataset case:
  // { id: "status-001", answer: "Done: ... Doing: ... Blocker: ... Next: ...", model: "Cursor built-in chat" },
];

interface EvalTestCase {
  id: string;
  category:
    | "one_on_one_basic"
    | "multiple_speakers_latest_turn"
    | "follow_up_history"
    | "ui_noise"
    | "status_update"
    | "unknown_answer"
    | "polite_disagreement"
    | "english_response_style";
  promptMode: PromptMode;
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  meetingStyle: "status" | "unknown" | "disagree" | "general";
  expectedBehavior: string[];
  forbidden?: string[];
  requiredSignals?: string[];
}

interface AgentAnswer {
  id: string;
  answer: string;
  model?: string;
}

interface RuleCheck {
  name: string;
  passed: boolean;
  reason: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const datasetPath = path.join(__dirname, "datasets", "interview-answer.dataset.json");
const resultsDir = path.join(__dirname, "results");

const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as EvalTestCase[];
const answersById = new Map(AGENT_ANSWERS.map((answer) => [answer.id, answer]));
const missingAnswers = dataset
  .filter((testCase) => !answersById.get(testCase.id)?.answer.trim())
  .map((testCase) => testCase.id);

if (missingAnswers.length > 0) {
  console.log("Fill AGENT_ANSWERS in evals/runEval.ts for these case ids:");
  console.log(missingAnswers.join(", "));
  console.log("Use buildAgentPrompt(testCase) in this script as the production prompt shape.");
  throw new Error(`Missing ${missingAnswers.length} eval answer(s).`);
}

const results = dataset.map((testCase) => {
  const agentAnswer = answersById.get(testCase.id);
  if (!agentAnswer) {
    throw new Error(`Missing answer for ${testCase.id}`);
  }
  const ruleGrade = gradeByRules(testCase, agentAnswer.answer);
  return {
    id: testCase.id,
    category: testCase.category,
    promptMode: testCase.promptMode,
    question: testCase.question,
    answer: agentAnswer.answer,
    model: agentAnswer.model || AGENT_NAME,
    ruleGrade,
    finalScore: ruleGrade.score,
  };
});

await mkdir(resultsDir, { recursive: true });
const outputPath = path.join(resultsDir, `eval-${timestamp()}.json`);
await writeFile(
  outputPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      generatedBy: AGENT_NAME,
      summary: {
        count: results.length,
        averageFinalScore: roundScore(average(results.map((result) => result.finalScore))),
      },
      results,
    },
    null,
    2,
  ),
);

console.log(
  `[eval] cases=${results.length} average=${average(
    results.map((result) => result.finalScore),
  ).toFixed(1)} wrote ${outputPath}`,
);

function buildAgentPrompt(testCase: EvalTestCase): string {
  const historyMessages = (testCase.history ?? []).map((turn) => ({
    role: turn.role,
    content:
      turn.role === "user"
        ? buildHistoryUserMessage(turn.content)
        : buildHistoryAssistantMessage(turn.content),
  }));

  return [
    "Simulate the production Teams Meeting prompt.",
    "Return only the final assistant answer, not JSON or explanation.",
    "",
    `Case: ${testCase.id}`,
    `Prompt mode: ${testCase.promptMode}`,
    `Meeting style: ${testCase.meetingStyle}`,
    "",
    "SYSTEM:",
    buildInterviewSystemPrompt(testCase.promptMode),
    "",
    "HISTORY:",
    JSON.stringify(historyMessages, null, 2),
    "",
    "USER:",
    buildInterviewUserPrompt(testCase.question, testCase.promptMode),
  ].join("\n");
}

function gradeByRules(
  testCase: EvalTestCase,
  answer: string,
): { score: number; checks: RuleCheck[] } {
  const checks: RuleCheck[] = [];
  const normalized = normalize(answer);
  const sentenceCount = countSentences(answer);

  addCheck(checks, "non_empty", normalized.length > 0, "Answer should not be empty.");
  addCheck(checks, "short", sentenceCount <= 2, "Answer should be 1 or 2 short sentences.");
  addCheck(checks, "one_paragraph", !answer.includes("\n\n"), "Answer should be one paragraph.");
  addCheck(
    checks,
    "no_meta",
    !containsAny(normalized, ["as an ai", "language model", "claude", "the transcript"]),
    "Answer should not mention AI, Claude, or the transcript.",
  );
  addCheck(
    checks,
    "no_forbidden_terms",
    !containsAny(normalized, testCase.forbidden ?? []),
    "Answer should avoid forbidden case terms.",
  );
  addCheck(
    checks,
    "simple_english",
    averageWordLength(answer) <= 6.2 &&
      !containsAny(normalized, [
        "aforementioned",
        "utilize",
        "comprehensive",
        "paradigm",
        "synergy",
      ]),
    "Answer should use simple English.",
  );

  if (testCase.category !== "ui_noise") {
    addCheck(
      checks,
      "first_person",
      /\b(i|my|me|i'm|i’d|i'll|i will|i would)\b/i.test(answer),
      "Answer should sound like Riem speaking in first person.",
    );
  }

  if (testCase.category === "ui_noise") {
    addCheck(
      checks,
      "ui_noise_fallback",
      normalized === "could you repeat the question?" ||
        normalized.includes("could you repeat the question"),
      "UI text should trigger the repeat-question fallback.",
    );
  }

  if (testCase.meetingStyle === "status") {
    addCheck(checks, "status_done", /\b(done|finished|completed)\b/i.test(answer), "Mention done.");
    addCheck(
      checks,
      "status_doing",
      /\b(doing|working on|in progress|now)\b/i.test(answer),
      "Mention doing/current work.",
    );
    addCheck(
      checks,
      "status_blocker",
      /\b(blocker|blocked|no blocker|no blockers|not blocked)\b/i.test(answer),
      "Mention blocker state.",
    );
    addCheck(checks, "status_next", /\b(next|after that|then|will)\b/i.test(answer), "Mention next step.");
  }

  if (testCase.meetingStyle === "unknown") {
    addCheck(
      checks,
      "unknown_check",
      /\b(check|verify|confirm|look it up|look into it)\b/i.test(answer),
      "Say Riem will check or verify.",
    );
    addCheck(
      checks,
      "unknown_timeline",
      /\b(today|after (the )?meeting|by (end of )?(today|tomorrow)|this afternoon|this morning|in \d+ (minutes|hours))\b/i.test(
        answer,
      ),
      "Give a concrete timeline.",
    );
  }

  if (testCase.meetingStyle === "disagree") {
    addCheck(
      checks,
      "polite_disagreement",
      !containsAny(normalized, ["bad idea", "wrong", "stupid", "obviously"]) &&
        /\b(i see|i understand|i agree with the goal|i get the idea|i think)\b/i.test(answer),
      "Disagree politely.",
    );
    addCheck(
      checks,
      "technical_reason",
      /\b(because|risk|state|user|edge case|performance|maintain|debug|api|loading|security)\b/i.test(
        answer,
      ),
      "Give a technical reason.",
    );
    addCheck(
      checks,
      "simple_alternative",
      /\b(instead|alternative|we can|i would|better option|simple option)\b/i.test(answer),
      "Suggest a simple alternative.",
    );
  }

  const passedCount = checks.filter((check) => check.passed).length;
  return { score: roundScore((passedCount / checks.length) * 10), checks };
}

function addCheck(checks: RuleCheck[], name: string, passed: boolean, reason: string): void {
  checks.push({ name, passed, reason });
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function containsAny(normalizedText: string, terms: string[]): boolean {
  return terms.some((term) => normalizedText.includes(term.toLowerCase()));
}

function countSentences(text: string): number {
  const matches = text.trim().match(/[^.!?]+[.!?]+/g);
  if (!matches) {
    return text.trim() ? 1 : 0;
  }
  return matches.length;
}

function averageWordLength(text: string): number {
  const words = text.match(/[A-Za-z]+/g) ?? [];
  if (words.length === 0) {
    return 0;
  }
  return words.reduce((sum, word) => sum + word.length, 0) / words.length;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

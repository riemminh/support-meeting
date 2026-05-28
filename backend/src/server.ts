import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { AnthropicProvider } from "./providers/AnthropicProvider.js";
import type { LLMProvider } from "./providers/LLMProvider.js";
import { isPromptMode, type PromptMode } from "./prompts/interviewPrompt.js";

interface AnalyzeRequestBody {
  question?: unknown;
  history?: unknown;
  promptMode?: unknown;
  pageUrl?: unknown;
  detectedAt?: unknown;
}

logEnvPresence();

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_QUESTION_LENGTH = requireEnvInt("MAX_QUESTION_LENGTH");
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  throw new Error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env first.");
}

const provider: LLMProvider = new AnthropicProvider(apiKey);
logEnvConfig();
const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked origin: ${origin}`));
    },
  }),
);
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_request: Request, response: Response) => {
  response.json({ ok: true });
});

app.post(
  "/analyze",
  async (
    request: Request<unknown, unknown, AnalyzeRequestBody>,
    response: Response,
  ) => {
    const validation = validateAnalyzeRequest(request.body);
    if (!validation.ok) {
      response.status(400).json({ error: validation.error });
      return;
    }

    try {
      const result = await provider.generateInterviewAnswer({
        question: validation.question,
        history: validation.history,
        promptMode: validation.promptMode,
      });
      response.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to generate answer.";
      response.status(502).json({ error: message });
    }
  },
);

app.post(
  "/analyze/stream",
  async (
    request: Request<unknown, unknown, AnalyzeRequestBody>,
    response: Response,
  ) => {
    const validation = validateAnalyzeRequest(request.body);
    if (!validation.ok) {
      response.status(400).json({ error: validation.error });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    try {
      response.write(
        `${JSON.stringify({
          type: "start",
          model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-20240620",
        })}\n`,
      );

      for await (const text of provider.streamInterviewAnswer({
        question: validation.question,
        history: validation.history,
        promptMode: validation.promptMode,
      })) {
        response.write(`${JSON.stringify({ type: "delta", text })}\n`);
      }

      response.write(`${JSON.stringify({ type: "done" })}\n`);
      response.end();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to stream answer.";
      response.write(`${JSON.stringify({ type: "error", error: message })}\n`);
      response.end();
    }
  },
);

app.listen(PORT, HOST, () => {
  console.log(`Teams Meeting Copilot backend listening on http://${HOST}:${PORT}`);
});

function requireEnvInt(name: string): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    throw new Error(`Missing ${name} in environment (.env).`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name} in environment (.env). Expected an integer.`);
  }
  return parsed;
}

function logEnvPresence(): void {
  const keys = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_MAX_TOKENS",
    "ANTHROPIC_TEMPERATURE",
    "MAX_QUESTION_LENGTH",
    "PORT",
    "HOST",
    "ALLOWED_ORIGIN",
  ];

  console.log("[env] Checking .env variables:");
  for (const key of keys) {
    const raw = process.env[key];
    const status = raw?.trim() ? "set" : "missing";
    console.log(`  - ${key}: ${status}`);
  }
}

function logEnvConfig(): void {
  const entries: Array<{ key: string; status: "set" | "missing"; value?: string }> = [
    envEntry("ANTHROPIC_API_KEY", maskSecret(process.env.ANTHROPIC_API_KEY)),
    envEntry("ANTHROPIC_MODEL", process.env.ANTHROPIC_MODEL),
    envEntry("ANTHROPIC_MAX_TOKENS", process.env.ANTHROPIC_MAX_TOKENS),
    envEntry("ANTHROPIC_TEMPERATURE", process.env.ANTHROPIC_TEMPERATURE),
    envEntry("MAX_QUESTION_LENGTH", String(MAX_QUESTION_LENGTH)),
    envEntry("PORT", String(PORT)),
    envEntry("HOST", HOST),
    envEntry("ALLOWED_ORIGIN", process.env.ALLOWED_ORIGIN || "(empty)"),
  ];

  console.log("[env] Loaded configuration:");
  for (const entry of entries) {
    const valueSuffix = entry.value ? ` = ${entry.value}` : "";
    console.log(`  - ${entry.key}: ${entry.status}${valueSuffix}`);
  }
}

function envEntry(
  key: string,
  value?: string,
): { key: string; status: "set" | "missing"; value?: string } {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { key, status: "missing" };
  }
  return { key, status: "set", value: trimmed };
}

function maskSecret(value?: string): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return "***";
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function validateAnalyzeRequest(
  body: AnalyzeRequestBody,
):
  | {
      ok: true;
      question: string;
      history?: { role: "user" | "assistant"; content: string }[];
      promptMode: PromptMode;
    }
  | {
      ok: false;
      error: string;
    } {
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (body.promptMode !== undefined && !isPromptMode(body.promptMode)) {
    return { ok: false, error: "Invalid prompt mode." };
  }
  const promptMode: PromptMode = body.promptMode ?? "one-on-one";

  if (!question) {
    return { ok: false, error: "Request must include one question." };
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    return {
      ok: false,
      error: `Question must be ${MAX_QUESTION_LENGTH} characters or fewer.`,
    };
  }

  if (looksLikeBulkTranscript(question, promptMode)) {
    return {
      ok: false,
      error:
        "Refusing likely bulk transcript. Send only one detected question or a manual selection.",
    };
  }

  let history: { role: "user" | "assistant"; content: string }[] | undefined;
  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) {
      return { ok: false, error: "History must be an array." };
    }
    history = [];
    for (const turn of body.history) {
      if (
        typeof turn !== "object" ||
        turn === null ||
        !("role" in turn) ||
        !("content" in turn) ||
        (turn.role !== "user" && turn.role !== "assistant") ||
        typeof turn.content !== "string"
      ) {
        return { ok: false, error: "Invalid conversation history format." };
      }
      history.push({
        role: turn.role,
        content: turn.content.trim(),
      });
    }
  }

  return { ok: true, question, history, promptMode };
}

function looksLikeBulkTranscript(question: string, promptMode: PromptMode): boolean {
  const speakerLabels = question.match(/\b[A-Z][A-Za-z .'-]{1,32}:\s/g) ?? [];
  const sentenceBreaks = question.match(/[.!?]\s+/g) ?? [];
  if (promptMode === "multiple-speakers") {
    return speakerLabels.length >= 8 || sentenceBreaks.length >= 12;
  }

  return speakerLabels.length >= 3 || sentenceBreaks.length >= 8;
}

function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.has(origin)) {
    return true;
  }

  try {
    const url = new URL(origin);
    return (
      url.protocol === "chrome-extension:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
    );
  } catch {
    return false;
  }
}

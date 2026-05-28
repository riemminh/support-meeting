import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, InterviewAnswerResult, InterviewAnswerInput, TranslateInput, TranslateResult } from "./LLMProvider.js";
import {
  buildHistoryAssistantMessage,
  buildInterviewSystemPrompt,
  buildInterviewUserPrompt,
  buildHistoryUserMessage,
} from "../prompts/interviewPrompt.js";
import {
  TRANSLATE_SYSTEM_PROMPT,
  buildTranslateUserPrompt,
} from "../prompts/translatePrompt.js";

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEnvFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requireEnv(name: string): string {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    throw new Error(`Missing ${name} in environment (.env).`);
  }
  return raw.trim();
}

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = (model ?? process.env.ANTHROPIC_MODEL)?.trim() || requireEnv("ANTHROPIC_MODEL");
    this.maxTokens = Math.min(
      Math.max(parseEnvInt("ANTHROPIC_MAX_TOKENS", Number.parseInt(requireEnv("ANTHROPIC_MAX_TOKENS"), 10)), 64),
      4096,
    );
    this.temperature = Math.min(
      Math.max(parseEnvFloat("ANTHROPIC_TEMPERATURE", Number.parseFloat(requireEnv("ANTHROPIC_TEMPERATURE"))), 0),
      1,
    );
  }

  async generateInterviewAnswer(
    input: InterviewAnswerInput,
  ): Promise<InterviewAnswerResult> {
    const messages: Anthropic.MessageParam[] = [];

    if (input.history && input.history.length > 0) {
      for (const turn of input.history) {
        messages.push({
          role: turn.role,
          content:
            turn.role === "user"
              ? buildHistoryUserMessage(turn.content)
              : buildHistoryAssistantMessage(turn.content),
        });
      }
    }

    messages.push({
      role: "user",
      content: buildInterviewUserPrompt(input.question, input.promptMode),
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system: buildInterviewSystemPrompt(input.promptMode),
      messages,
    });

    const answer = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();

    return {
      answer,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async *streamInterviewAnswer(
    input: InterviewAnswerInput,
  ): AsyncIterable<string> {
    const messages: Anthropic.MessageParam[] = [];

    if (input.history && input.history.length > 0) {
      for (const turn of input.history) {
        messages.push({
          role: turn.role,
          content:
            turn.role === "user"
              ? buildHistoryUserMessage(turn.content)
              : buildHistoryAssistantMessage(turn.content),
        });
      }
    }

    messages.push({
      role: "user",
      content: buildInterviewUserPrompt(input.question, input.promptMode),
    });

    const stream = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system: buildInterviewSystemPrompt(input.promptMode),
      messages,
      stream: true,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  }

  async translateText(input: TranslateInput): Promise<TranslateResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      temperature: 0.2,
      system: TRANSLATE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildTranslateUserPrompt(input.text),
        },
      ],
    });

    const translation = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();

    return {
      translation,
      model: response.model,
    };
  }
}

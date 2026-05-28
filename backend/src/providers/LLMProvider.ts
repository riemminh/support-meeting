import type { PromptMode } from "../prompts/interviewPrompt.js";

export interface InterviewAnswerInput {
  question: string;
  history?: { role: "user" | "assistant"; content: string }[];
  promptMode: PromptMode;
}

export interface InterviewAnswerResult {
  answer: string;
  model: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface TranslateInput {
  text: string;
}

export interface TranslateResult {
  translation: string;
  model: string;
}

export interface LLMProvider {
  generateInterviewAnswer(
    input: InterviewAnswerInput,
  ): Promise<InterviewAnswerResult>;
  streamInterviewAnswer(input: InterviewAnswerInput): AsyncIterable<string>;
  translateText(input: TranslateInput): Promise<TranslateResult>;
}

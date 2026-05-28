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

export interface LLMProvider {
  generateInterviewAnswer(
    input: InterviewAnswerInput,
  ): Promise<InterviewAnswerResult>;
  streamInterviewAnswer(input: InterviewAnswerInput): AsyncIterable<string>;
}

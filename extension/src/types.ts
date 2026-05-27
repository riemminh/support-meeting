export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnalyzeRequest {
  question: string;
  history?: ChatMessage[];
  source: "auto-detected" | "manual" | "selection";
  pageUrl?: string;
  detectedAt: string;
}

export interface AnalyzeResponse {
  answer: string;
  model: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface AnalyzeErrorResponse {
  error: string;
}

export type AnalyzeResult = AnalyzeResponse | AnalyzeErrorResponse;

export interface CopilotSettings {
  backendUrl: string;
  autoDetect: boolean;
  ignoredSpeakerName?: string;
  overlayPosition?: {
    left: number;
    top: number;
  };
}

export type BackgroundMessage =
  | {
      type: "ANALYZE_QUESTION";
      payload: AnalyzeRequest;
    }
  | {
      type: "GET_SETTINGS";
    }
  | {
      type: "SAVE_SETTINGS";
      payload: Partial<CopilotSettings>;
    };

export interface AnalyzeStreamStartMessage {
  type: "START";
  payload: AnalyzeRequest;
}

export type AnalyzeStreamMessage =
  | {
      type: "start";
      model?: string;
    }
  | {
      type: "delta";
      text: string;
    }
  | {
      type: "done";
    }
  | {
      type: "error";
      error: string;
    };

export interface BackgroundAnalyzeSuccess {
  ok: true;
  data: AnalyzeResponse;
}

export interface BackgroundAnalyzeFailure {
  ok: false;
  error: string;
}

export type BackgroundAnalyzeReply =
  | BackgroundAnalyzeSuccess
  | BackgroundAnalyzeFailure;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type PromptMode = "one-on-one" | "multiple-speakers";

export interface AnalyzeRequest {
  question: string;
  history?: ChatMessage[];
  promptMode: PromptMode;
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

export interface TranslateResponse {
  translation: string;
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

export interface MeetingSettings {
  backendUrl: string;
  autoDetect: boolean;
  promptMode: PromptMode;
  ignoredSpeakerName?: string;
  overlayPosition?: {
    left: number;
    top: number;
  };
  overlaySize?: {
    width: number;
    height: number;
  };
}

export type LatestTranscriptReply =
  | {
      ok: true;
      question: string;
    }
  | {
      ok: false;
      error: string;
    };

export type BackgroundTranslateReply =
  | {
      ok: true;
      data: TranslateResponse;
    }
  | {
      ok: false;
      error: string;
    };

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
      payload: Partial<MeetingSettings>;
    }
  | {
      type: "OPEN_DETACHED_PANEL";
    }
  | {
      type: "GET_LATEST_TRANSCRIPT";
      linesToGrab?: number;
    }
  | {
      type: "RESTORE_IN_PAGE_OVERLAY";
    }
  | {
      type: "TRANSLATE_TEXT";
      text: string;
    };

export type ContentScriptMessage =
  | {
      type: "READ_LATEST_TRANSCRIPT";
      linesToGrab?: number;
    }
  | {
      type: "SET_IN_PAGE_OVERLAY_VISIBLE";
      visible: boolean;
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

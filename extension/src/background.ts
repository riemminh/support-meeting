import type {
  AnalyzeResponse,
  BackgroundAnalyzeReply,
  BackgroundMessage,
  CopilotSettings,
  AnalyzeStreamMessage,
  AnalyzeStreamStartMessage,
} from "./types";

const DEFAULT_SETTINGS: CopilotSettings = {
  backendUrl: "http://localhost:8787",
  autoDetect: true,
  ignoredSpeakerName: "",
  overlayPosition: undefined,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...settings });
  });
});

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundMessage,
    _sender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (message.type === "GET_SETTINGS") {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
        sendResponse({ ...DEFAULT_SETTINGS, ...settings });
      });
      return true;
    }

    if (message.type === "SAVE_SETTINGS") {
      chrome.storage.sync.set(message.payload, () => {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === "ANALYZE_QUESTION") {
      analyzeQuestion(message)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "Unknown backend error",
          } satisfies BackgroundAnalyzeReply);
        });
      return true;
    }

    return false;
  },
);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ANALYZE_STREAM") {
    return;
  }

  const controller = new AbortController();
  port.onDisconnect.addListener(() => {
    controller.abort();
  });

  port.onMessage.addListener((message: AnalyzeStreamStartMessage) => {
    if (message.type !== "START") {
      return;
    }

    streamQuestion(message.payload, port, controller.signal).catch(
      (error: unknown) => {
        postToPort(port, {
          type: "error",
          error:
            error instanceof Error ? error.message : "Unknown streaming error",
        });
      },
    );
  });
});

async function analyzeQuestion(
  message: Extract<BackgroundMessage, { type: "ANALYZE_QUESTION" }>,
): Promise<BackgroundAnalyzeReply> {
  const settings = await getSettings();
  const response = await fetch(`${settings.backendUrl.replace(/\/$/, "")}/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message.payload),
  });

  const data = (await response.json().catch(() => undefined)) as unknown;

  if (!response.ok) {
    return {
      ok: false,
      error:
        getErrorMessage(data) ?? `Backend returned HTTP ${response.status}`,
    };
  }

  if (!isAnalyzeResponse(data)) {
    return {
      ok: false,
      error: "Backend response did not include an answer.",
    };
  }

  return {
    ok: true,
    data,
  };
}

function isAnalyzeResponse(data: unknown): data is AnalyzeResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    "answer" in data &&
    typeof data.answer === "string" &&
    "model" in data &&
    typeof data.model === "string"
  );
}

function getErrorMessage(data: unknown): string | undefined {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string"
  ) {
    return data.error;
  }
  return undefined;
}

function getSettings(): Promise<CopilotSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
      resolve({ ...DEFAULT_SETTINGS, ...settings });
    });
  });
}

async function streamQuestion(
  payload: Extract<BackgroundMessage, { type: "ANALYZE_QUESTION" }>["payload"],
  port: chrome.runtime.Port,
  signal: AbortSignal,
): Promise<void> {
  const settings = await getSettings();
  const response = await fetch(
    `${settings.backendUrl.replace(/\/$/, "")}/analyze/stream`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    },
  );

  if (!response.ok) {
    const data = (await response.json().catch(() => undefined)) as unknown;
    postToPort(port, {
      type: "error",
      error: getErrorMessage(data) ?? `Backend returned HTTP ${response.status}`,
    });
    return;
  }

  if (!response.body) {
    postToPort(port, {
      type: "error",
      error: "Backend did not return a readable stream.",
    });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      postStreamLine(port, line);
    }
  }

  if (buffer.trim()) {
    postStreamLine(port, buffer);
  }
}

function postStreamLine(port: chrome.runtime.Port, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  const message = JSON.parse(trimmed) as AnalyzeStreamMessage;
  postToPort(port, message);
}

function postToPort(port: chrome.runtime.Port, message: AnalyzeStreamMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // The tab may have navigated or the content script may have disconnected.
  }
}

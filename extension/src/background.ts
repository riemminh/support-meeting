import type {
  AnalyzeResponse,
  BackgroundAnalyzeReply,
  BackgroundTranslateReply,
  BackgroundMessage,
  CopilotSettings,
  LatestTranscriptReply,
  TranslateResponse,
  AnalyzeStreamMessage,
  AnalyzeStreamStartMessage,
} from "./types";

const DEFAULT_SETTINGS: CopilotSettings = {
  backendUrl: "http://localhost:8787",
  autoDetect: true,
  promptMode: "one-on-one",
  ignoredSpeakerName: "",
  overlayPosition: undefined,
  overlaySize: undefined,
};

const LAST_TEAMS_TAB_ID_KEY = "lastTeamsTabId";
const TEAMS_URL_PATTERNS = [
  "https://teams.microsoft.com/*",
  "https://*.teams.microsoft.com/*",
  "https://teams.live.com/*",
  "https://*.teams.live.com/*",
  "https://teams.cloud.microsoft/*",
  "https://*.teams.cloud.microsoft/*",
];

let lastTeamsTabId: number | undefined;
let detachedPanelWindowId: number | undefined;

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

    if (message.type === "OPEN_DETACHED_PANEL") {
      rememberTeamsTab(_sender.tab)
        .then(openDetachedPanel)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not open separate window.",
          });
        });
      return true;
    }

    if (message.type === "GET_LATEST_TRANSCRIPT") {
      getLatestTranscriptFromTeamsTab(message.linesToGrab)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not read latest transcript from Teams.",
          } satisfies LatestTranscriptReply);
        });
      return true;
    }

    if (message.type === "RESTORE_IN_PAGE_OVERLAY") {
      restoreInPageOverlay()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not restore Teams overlay.",
          });
        });
      return true;
    }

    if (message.type === "TRANSLATE_TEXT") {
      translateText(message.text)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "Unknown translation error",
          } satisfies BackgroundTranslateReply);
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

  void rememberTeamsTab(port.sender?.tab);

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

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === detachedPanelWindowId) {
    detachedPanelWindowId = undefined;
  }
});

chrome.action.onClicked.addListener((tab) => {
  rememberTeamsTab(tab)
    .then(openDetachedPanel)
    .catch(() => {
      // The user can still open the panel from the in-page overlay if Chrome blocks this action.
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

function isTranslateResponse(data: unknown): data is TranslateResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    "translation" in data &&
    typeof data.translation === "string" &&
    "model" in data &&
    typeof data.model === "string"
  );
}

async function translateText(text: string): Promise<BackgroundTranslateReply> {
  const settings = await getSettings();
  const response = await fetch(`${settings.backendUrl.replace(/\/$/, "")}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  const data = (await response.json().catch(() => undefined)) as unknown;

  if (!response.ok) {
    return {
      ok: false,
      error:
        getErrorMessage(data) ?? `Backend returned HTTP ${response.status}`,
    };
  }

  if (!isTranslateResponse(data)) {
    return {
      ok: false,
      error: "Backend response did not include a translation.",
    };
  }

  return {
    ok: true,
    data,
  };
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

async function openDetachedPanel(): Promise<void> {
  if (detachedPanelWindowId !== undefined) {
    const existingWindow = await getWindow(detachedPanelWindowId).catch(() => undefined);
    if (existingWindow) {
      await updateWindow(detachedPanelWindowId, { focused: true });
      return;
    }
  }

  const createdWindow = await createPanelWindow();
  detachedPanelWindowId = createdWindow.id;
}

function createPanelWindow(): Promise<chrome.windows.Window> {
  return new Promise((resolve, reject) => {
    chrome.windows.create(
      {
        url: chrome.runtime.getURL("panel.html"),
        type: "popup",
        width: 520,
        height: 720,
        focused: true,
      },
      (createdWindow) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        if (!createdWindow) {
          reject(new Error("Chrome did not create the panel window."));
          return;
        }

        resolve(createdWindow);
      },
    );
  });
}

function getWindow(windowId: number): Promise<chrome.windows.Window> {
  return new Promise((resolve, reject) => {
    chrome.windows.get(windowId, (existingWindow) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(existingWindow);
    });
  });
}

function updateWindow(
  windowId: number,
  updateInfo: chrome.windows.UpdateInfo,
): Promise<chrome.windows.Window> {
  return new Promise((resolve, reject) => {
    chrome.windows.update(windowId, updateInfo, (updatedWindow) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      if (!updatedWindow) {
        reject(new Error("Chrome did not focus the panel window."));
        return;
      }

      resolve(updatedWindow);
    });
  });
}

async function getLatestTranscriptFromTeamsTab(
  linesToGrab?: number,
): Promise<LatestTranscriptReply> {
  const teamsTabId = await resolveTeamsTabId();
  if (teamsTabId === undefined) {
    return {
      ok: false,
      error: "Could not find an open Teams tab. Open Teams, then open the separate window from the overlay.",
    };
  }

  return sendTabMessage<LatestTranscriptReply>(teamsTabId, {
    type: "READ_LATEST_TRANSCRIPT",
    linesToGrab,
  });
}

async function restoreInPageOverlay(): Promise<void> {
  const teamsTabId = await resolveTeamsTabId();
  if (teamsTabId === undefined) {
    return;
  }

  await sendTabMessage(teamsTabId, {
    type: "SET_IN_PAGE_OVERLAY_VISIBLE",
    visible: true,
  });
}

async function rememberTeamsTab(tab?: chrome.tabs.Tab): Promise<void> {
  if (tab?.id === undefined || !isTeamsUrl(tab.url)) {
    return;
  }

  lastTeamsTabId = tab.id;
  await setSessionValue(LAST_TEAMS_TAB_ID_KEY, tab.id);
}

async function resolveTeamsTabId(): Promise<number | undefined> {
  if (lastTeamsTabId !== undefined && (await canReadFromTeamsTab(lastTeamsTabId))) {
    return lastTeamsTabId;
  }

  const storedTabId = await getStoredTeamsTabId();
  if (storedTabId !== undefined && (await canReadFromTeamsTab(storedTabId))) {
    lastTeamsTabId = storedTabId;
    return storedTabId;
  }

  const fallbackTab = await findOpenTeamsTab();
  if (fallbackTab?.id !== undefined) {
    await rememberTeamsTab(fallbackTab);
    return fallbackTab.id;
  }

  return undefined;
}

async function canReadFromTeamsTab(tabId: number): Promise<boolean> {
  const tab = await getTab(tabId).catch(() => undefined);
  return Boolean(tab?.id !== undefined && isTeamsUrl(tab.url));
}

function getStoredTeamsTabId(): Promise<number | undefined> {
  return getSessionValue(LAST_TEAMS_TAB_ID_KEY).then((value) => {
    return typeof value === "number" ? value : undefined;
  });
}

function findOpenTeamsTab(): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: TEAMS_URL_PATTERNS }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve(undefined);
        return;
      }

      resolve(tabs.find((tab) => tab.id !== undefined && isTeamsUrl(tab.url)));
    });
  });
}

function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(tab);
    });
  });
}

function isTeamsUrl(url?: string): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.protocol === "https:" &&
      (parsedUrl.hostname === "teams.microsoft.com" ||
        parsedUrl.hostname.endsWith(".teams.microsoft.com") ||
        parsedUrl.hostname === "teams.live.com" ||
        parsedUrl.hostname.endsWith(".teams.live.com") ||
        parsedUrl.hostname === "teams.cloud.microsoft" ||
        parsedUrl.hostname.endsWith(".teams.cloud.microsoft"))
    );
  } catch {
    return false;
  }
}

function getSessionValue(key: string): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.storage.session.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve(undefined);
        return;
      }

      resolve(items[key]);
    });
  });
}

function setSessionValue(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.session.set({ [key]: value }, () => {
      resolve();
    });
  });
}

function sendTabMessage<TResponse>(
  tabId: number,
  message: unknown,
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: TResponse) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
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

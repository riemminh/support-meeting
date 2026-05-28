import type {
  AnalyzeRequest,
  AnalyzeStreamMessage,
  BackgroundTranslateReply,
  BackgroundMessage,
  ChatMessage,
  CopilotSettings,
  LatestTranscriptReply,
} from "./types";

const DEFAULT_SETTINGS: CopilotSettings = {
  backendUrl: "http://localhost:8787",
  autoDetect: true,
  promptMode: "one-on-one",
  ignoredSpeakerName: "",
  overlayPosition: undefined,
  overlaySize: undefined,
};

let conversationHistory: ChatMessage[] = [];
let settings: CopilotSettings = DEFAULT_SETTINGS;

class PanelView {
  private readonly manualInput: HTMLTextAreaElement;
  private readonly backendInput: HTMLInputElement;
  private readonly ignoredSpeakerInput: HTMLInputElement;
  private readonly promptModeSelect: HTMLSelectElement;
  private readonly autoDetectInput: HTMLInputElement;
  private readonly linesInput: HTMLInputElement;
  private readonly status: HTMLDivElement;
  private readonly questionBox: HTMLDivElement;
  private readonly answerBox: HTMLDivElement;
  private readonly errorBox: HTMLDivElement;
  private readonly analyzeButton: HTMLButtonElement;

  constructor() {
    document.body.classList.add("tic-panel-page");
    document.body.innerHTML = `
      <div class="tic-overlay" data-panel="true">
        <div class="tic-header">
          <div>
            <div class="tic-title">Teams Interview Copilot</div>
            <div class="tic-subtitle">Separate answer window</div>
          </div>
          <div class="tic-header-actions">
            <button class="tic-icon-button" data-action="selection" title="Load latest from Teams" aria-label="Load latest from Teams">S</button>
            <button class="tic-icon-button" data-action="restore" title="Show in-page overlay" aria-label="Show in-page overlay">P</button>
          </div>
        </div>
        <div class="tic-body">
          <textarea class="tic-input" placeholder="Paste transcript or one interviewer question..."></textarea>
          <div class="tic-row" style="align-items: center; gap: 8px;">
            <button class="tic-button tic-button-primary" data-action="manual">Analyze transcript</button>
            <button class="tic-button" data-action="selection" title="Use selected text from Teams, or latest transcript if nothing is selected">Use selection</button>
            <label class="tic-lines-control" title="Number of latest transcript lines to grab">
              <span>Lines</span>
              <input class="tic-lines" type="number" min="1" max="10" value="1" aria-label="Lines to grab" />
            </label>
          </div>
          <div class="tic-settings">
            <input class="tic-url" type="url" aria-label="Backend URL" />
            <select class="tic-prompt-mode" aria-label="Prompt mode">
              <option value="one-on-one">1-1 prompt</option>
              <option value="multiple-speakers">Multiple speakers</option>
            </select>
            <input class="tic-speaker" type="text" aria-label="Ignore speaker" placeholder="Ignore speaker: your Teams name" />
            <div class="tic-row" style="grid-column: 1 / -1; justify-content: space-between; align-items: center;">
              <label class="tic-checkbox">
                <input type="checkbox" class="tic-auto-detect" />
                Prepare latest
              </label>
              <button class="tic-button tic-button-sm" data-action="clear-history" title="Clear conversation history">Clear History</button>
            </div>
          </div>
          <div class="tic-status"></div>
          <div class="tic-question" hidden>
            <div class="tic-box-header">
              <div class="tic-label">Question</div>
              <button class="tic-translate-button" data-action="translate-question">Dịch</button>
            </div>
            <div data-slot="question"></div>
            <div class="tic-translation" data-slot="question-translation" hidden></div>
          </div>
          <div class="tic-answer" hidden>
            <div class="tic-box-header">
              <div class="tic-label">Suggested answer</div>
              <button class="tic-translate-button" data-action="translate-answer">Dịch</button>
            </div>
            <div data-slot="answer"></div>
            <div class="tic-translation" data-slot="answer-translation" hidden></div>
          </div>
          <div class="tic-error" hidden></div>
          <div class="tic-status">Keep this window outside the shared Teams tab/window.</div>
        </div>
      </div>
    `;

    this.manualInput = document.querySelector(".tic-input") as HTMLTextAreaElement;
    this.backendInput = document.querySelector(".tic-url") as HTMLInputElement;
    this.ignoredSpeakerInput = document.querySelector(".tic-speaker") as HTMLInputElement;
    this.promptModeSelect = document.querySelector(
      ".tic-prompt-mode",
    ) as HTMLSelectElement;
    this.autoDetectInput = document.querySelector(".tic-auto-detect") as HTMLInputElement;
    this.linesInput = document.querySelector(".tic-lines") as HTMLInputElement;
    this.status = document.querySelector(".tic-status") as HTMLDivElement;
    this.questionBox = document.querySelector(".tic-question") as HTMLDivElement;
    this.answerBox = document.querySelector(".tic-answer") as HTMLDivElement;
    this.errorBox = document.querySelector(".tic-error") as HTMLDivElement;
    this.analyzeButton = document.querySelector(
      '[data-action="manual"]',
    ) as HTMLButtonElement;

    this.bindEvents();
  }

  setSettings(settings: CopilotSettings): void {
    this.backendInput.value = settings.backendUrl;
    this.ignoredSpeakerInput.value = settings.ignoredSpeakerName ?? "";
    this.promptModeSelect.value = settings.promptMode;
    this.autoDetectInput.checked = settings.autoDetect;
  }

  setDraft(input: string, status: string): void {
    this.clearError();
    this.manualInput.value = input;
    if (input.trim()) {
      this.setQuestion(input);
    }
    this.setStatus(status);
  }

  startAnswerStream(question: string): void {
    this.clearError();
    this.setQuestion(question);
    this.answerBox.hidden = false;
    const answerSlot = this.answerBox.querySelector('[data-slot="answer"]');
    if (answerSlot) {
      answerSlot.textContent = "";
    }
    this.clearTranslation("answer");
    this.setStatus("Streaming suggestion...");
    this.analyzeButton.disabled = true;
  }

  appendAnswerDelta(delta: string): void {
    this.answerBox.hidden = false;
    const answerSlot = this.answerBox.querySelector('[data-slot="answer"]');
    if (answerSlot) {
      answerSlot.textContent = `${answerSlot.textContent ?? ""}${delta}`;
    }
  }

  finishAnswerStream(model?: string): void {
    this.analyzeButton.disabled = false;
    this.clearError();
    this.setStatus(model ? `Suggestion ready from ${model}.` : "Suggestion ready.");
  }

  setError(message: string): void {
    this.analyzeButton.disabled = false;
    this.errorBox.hidden = false;
    this.errorBox.textContent = message;
    this.setStatus("Could not generate suggestion.");
  }

  get linesToGrab(): number {
    const val = Number.parseInt(this.linesInput.value, 10);
    return Number.isNaN(val) ? 1 : Math.min(Math.max(val, 1), 10);
  }

  private bindEvents(): void {
    document.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (!action) {
        return;
      }

      if (action === "manual") {
        analyzeQuestion(this.manualInput.value, "manual");
      }

      if (action === "selection") {
        void loadLatestTranscript();
      }

      if (action === "restore") {
        restoreInPageOverlay();
      }

      if (action === "translate-question") {
        void this.translateSlot("question");
      }

      if (action === "translate-answer") {
        void this.translateSlot("answer");
      }

      if (action === "clear-history") {
        conversationHistory = [];
        this.setDraft("", "Conversation history cleared.");
      }
    });

    this.backendInput.addEventListener("change", () => {
      settings = { ...settings, backendUrl: this.backendInput.value.trim() };
      sendMessage({
        type: "SAVE_SETTINGS",
        payload: { backendUrl: settings.backendUrl },
      }).catch(() => {
        this.setError("Could not save extension settings.");
      });
    });

    this.ignoredSpeakerInput.addEventListener("change", () => {
      settings = {
        ...settings,
        ignoredSpeakerName: this.ignoredSpeakerInput.value.trim(),
      };
      sendMessage({
        type: "SAVE_SETTINGS",
        payload: { ignoredSpeakerName: settings.ignoredSpeakerName },
      }).catch(() => {
        this.setError("Could not save extension settings.");
      });
    });

    this.promptModeSelect.addEventListener("change", () => {
      settings = {
        ...settings,
        promptMode:
          this.promptModeSelect.value === "multiple-speakers"
            ? "multiple-speakers"
            : "one-on-one",
      };
      sendMessage({
        type: "SAVE_SETTINGS",
        payload: { promptMode: settings.promptMode },
      }).catch(() => {
        this.setError("Could not save extension settings.");
      });
    });

    this.autoDetectInput.addEventListener("change", () => {
      settings = { ...settings, autoDetect: this.autoDetectInput.checked };
      sendMessage({
        type: "SAVE_SETTINGS",
        payload: { autoDetect: settings.autoDetect },
      }).catch(() => {
        this.setError("Could not save extension settings.");
      });
    });
  }

  private setQuestion(question: string): void {
    this.questionBox.hidden = false;
    const questionSlot = this.questionBox.querySelector('[data-slot="question"]');
    if (questionSlot) {
      questionSlot.textContent = question;
    }
    this.clearTranslation("question");
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }

  private clearError(): void {
    this.errorBox.hidden = true;
    this.errorBox.textContent = "";
  }

  private async translateSlot(slotName: "question" | "answer"): Promise<void> {
    const textSlot = document.querySelector(`[data-slot="${slotName}"]`);
    const text = textSlot?.textContent?.trim() ?? "";
    if (!text) {
      return;
    }

    this.setTranslation(slotName, "Đang dịch...");
    try {
      const translation = await translateText(text);
      this.setTranslation(slotName, translation);
    } catch (error) {
      this.setTranslation(
        slotName,
        error instanceof Error ? error.message : "Không dịch được đoạn này.",
      );
    }
  }

  private setTranslation(slotName: "question" | "answer", translation: string): void {
    const translationSlot = document.querySelector(
      `[data-slot="${slotName}-translation"]`,
    );
    if (!translationSlot) {
      return;
    }

    translationSlot.textContent = translation;
    (translationSlot as HTMLElement).hidden = false;
  }

  private clearTranslation(slotName: "question" | "answer"): void {
    const translationSlot = document.querySelector(
      `[data-slot="${slotName}-translation"]`,
    );
    if (!translationSlot) {
      return;
    }

    translationSlot.textContent = "";
    (translationSlot as HTMLElement).hidden = true;
  }
}

const panel = new PanelView();
void initialize();

async function initialize(): Promise<void> {
  settings = await sendMessage<CopilotSettings>({ type: "GET_SETTINGS" }).catch(
    () => DEFAULT_SETTINGS,
  );
  panel.setSettings(settings);
  installSettingsListener();
  panel.setDraft("", "Separate window ready. Use selection loads selected text or latest transcript from Teams.");
}

function installSettingsListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    const nextSettings: Partial<CopilotSettings> = {};
    if (changes.backendUrl?.newValue !== undefined) {
      nextSettings.backendUrl = String(changes.backendUrl.newValue);
    }
    if (changes.autoDetect?.newValue !== undefined) {
      nextSettings.autoDetect = Boolean(changes.autoDetect.newValue);
    }
    if (changes.promptMode?.newValue === "multiple-speakers") {
      nextSettings.promptMode = "multiple-speakers";
    }
    if (changes.promptMode?.newValue === "one-on-one") {
      nextSettings.promptMode = "one-on-one";
    }
    if (changes.ignoredSpeakerName?.newValue !== undefined) {
      nextSettings.ignoredSpeakerName = String(changes.ignoredSpeakerName.newValue);
    }

    if (Object.keys(nextSettings).length > 0) {
      settings = { ...settings, ...nextSettings };
      panel.setSettings(settings);
    }
  });
}

async function loadLatestTranscript(): Promise<void> {
  const reply = await sendMessage<LatestTranscriptReply>({
    type: "GET_LATEST_TRANSCRIPT",
    linesToGrab: panel.linesToGrab,
  }).catch((error: unknown): LatestTranscriptReply => {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not read latest transcript from Teams.",
    };
  });

  if (!reply.ok) {
    panel.setError(reply.error);
    return;
  }

  panel.setDraft(
    reply.question,
    "Selection or transcript loaded from Teams. Click Analyze transcript when ready.",
  );
}

function analyzeQuestion(
  input: string,
  source: AnalyzeRequest["source"],
): void {
  const question = input.trim();
  if (!question) {
    panel.setError("Paste a question or use selection from the Teams tab first.");
    return;
  }

  const payload: AnalyzeRequest = {
    question,
    history: conversationHistory,
    promptMode: settings.promptMode,
    source,
    detectedAt: new Date().toISOString(),
  };

  streamAnalyzeQuestion(payload);
}

function streamAnalyzeQuestion(payload: AnalyzeRequest): void {
  const port = chrome.runtime.connect({ name: "ANALYZE_STREAM" });
  let model: string | undefined;
  let accumulatedAnswer = "";

  panel.startAnswerStream(payload.question);

  port.onMessage.addListener((message: AnalyzeStreamMessage) => {
    if (message.type === "start") {
      model = message.model;
      return;
    }

    if (message.type === "delta") {
      accumulatedAnswer += message.text;
      panel.appendAnswerDelta(message.text);
      return;
    }

    if (message.type === "done") {
      panel.finishAnswerStream(model);
      if (accumulatedAnswer.trim()) {
        saveToConversationHistory(payload.question, accumulatedAnswer.trim());
      }
      port.disconnect();
      return;
    }

    if (message.type === "error") {
      panel.setError(message.error);
      port.disconnect();
    }
  });

  port.postMessage({ type: "START", payload });
}

async function translateText(text: string): Promise<string> {
  const reply = await sendMessage<BackgroundTranslateReply>({
    type: "TRANSLATE_TEXT",
    text,
  });

  if (!reply.ok) {
    throw new Error(reply.error);
  }

  return reply.data.translation;
}

function saveToConversationHistory(question: string, answer: string): void {
  conversationHistory.push({ role: "user", content: question });
  conversationHistory.push({ role: "assistant", content: answer });

  const maxHistoryTurns = 5;
  if (conversationHistory.length > maxHistoryTurns * 2) {
    conversationHistory = conversationHistory.slice(-maxHistoryTurns * 2);
  }
}

function restoreInPageOverlay(): void {
  sendMessage<{ ok: true } | { ok: false; error: string }>({
    type: "RESTORE_IN_PAGE_OVERLAY",
  })
    .then((reply) => {
      if (!reply.ok) {
        panel.setError(reply.error);
        return;
      }

      panel.setDraft("", "In-page overlay restored in Teams.");
    })
    .catch((error: unknown) => {
      panel.setError(
        error instanceof Error ? error.message : "Could not restore Teams overlay.",
      );
    });
}

function sendMessage<TResponse = unknown>(
  message: BackgroundMessage,
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: TResponse) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

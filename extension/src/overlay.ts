import type { AnalyzeResponse, CopilotSettings } from "./types";

export interface OverlayHandlers {
  onAnalyze(input: string, source: "manual" | "selection"): void;
  onPickTranscript(): void;
  onSettingsChange(settings: Partial<CopilotSettings>): void;
  onClearHistory?(): void;
  onDetachPanel?(): void;
  onTranslateText?(text: string): Promise<string>;
}

export interface OverlayOptions {
  detachedPanel?: boolean;
}

export class CopilotOverlay {
  private static readonly MIN_WIDTH = 360;
  private static readonly MIN_HEIGHT = 260;
  private static readonly VIEWPORT_MARGIN = 8;

  private readonly root: HTMLDivElement;
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
  private readonly header: HTMLDivElement;
  private readonly resizeHandle: HTMLDivElement;
  private minimized = false;
  private dragState:
    | {
        pointerId: number;
        offsetX: number;
        offsetY: number;
      }
    | undefined;
  private resizeState:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        startWidth: number;
        startHeight: number;
      }
    | undefined;

  constructor(
    private readonly handlers: OverlayHandlers,
    private readonly options: OverlayOptions = {},
  ) {
    this.root = document.createElement("div");
    this.root.className = "tic-overlay";
    this.root.setAttribute("role", "complementary");
    this.root.setAttribute("aria-label", "Teams Interview Copilot");

    this.root.innerHTML = `
      <div class="tic-header">
        <div>
          <div class="tic-title">Teams Interview Copilot</div>
          <div class="tic-subtitle">Transcript to interview answer</div>
        </div>
        <div class="tic-header-actions">
          <button class="tic-icon-button" data-action="selection" title="Load selected transcript" aria-label="Load selected transcript">S</button>
          <button class="tic-icon-button" data-action="detach" title="${this.options.detachedPanel ? "Show in-page overlay" : "Open separate window"}" aria-label="${this.options.detachedPanel ? "Show in-page overlay" : "Open separate window"}">${this.options.detachedPanel ? "P" : "W"}</button>
          <button class="tic-icon-button" data-action="minimize" title="Minimize" aria-label="Minimize">_</button>
        </div>
      </div>
      <div class="tic-body">
        <textarea class="tic-input" placeholder="Paste transcript or one interviewer question..."></textarea>
        <div class="tic-row" style="align-items: center; gap: 8px;">
          <button class="tic-button tic-button-primary" data-action="manual">Analyze transcript</button>
          <button class="tic-button" data-action="selection">Use selection</button>
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
        <div class="tic-status">
          Mac: <span class="tic-kbd">⌘</span> + <span class="tic-kbd">Shift</span> + <span class="tic-kbd">K</span> loads selected/latest transcript. <span class="tic-kbd">⌘</span> + <span class="tic-kbd">Shift</span> + <span class="tic-kbd">L</span> focuses input.
        </div>
      </div>
      <div class="tic-resize-handle" title="Resize" aria-hidden="true"></div>
    `;

    this.manualInput = this.root.querySelector(".tic-input") as HTMLTextAreaElement;
    this.backendInput = this.root.querySelector(".tic-url") as HTMLInputElement;
    this.linesInput = this.root.querySelector(".tic-lines") as HTMLInputElement;
    this.promptModeSelect = this.root.querySelector(
      ".tic-prompt-mode",
    ) as HTMLSelectElement;
    this.ignoredSpeakerInput = this.root.querySelector(
      ".tic-speaker",
    ) as HTMLInputElement;
    this.autoDetectInput = this.root.querySelector(
      ".tic-auto-detect",
    ) as HTMLInputElement;
    this.status = this.root.querySelector(".tic-status") as HTMLDivElement;
    this.questionBox = this.root.querySelector(".tic-question") as HTMLDivElement;
    this.answerBox = this.root.querySelector(".tic-answer") as HTMLDivElement;
    this.errorBox = this.root.querySelector(".tic-error") as HTMLDivElement;
    this.header = this.root.querySelector(".tic-header") as HTMLDivElement;
    this.resizeHandle = this.root.querySelector(
      ".tic-resize-handle",
    ) as HTMLDivElement;
    this.analyzeButton = this.root.querySelector(
      '[data-action="manual"]',
    ) as HTMLButtonElement;

    this.bindEvents();
    document.documentElement.appendChild(this.root);
    if (this.options.detachedPanel) {
      this.root.dataset.panel = "true";
    }
  }

  setSettings(settings: CopilotSettings): void {
    this.backendInput.value = settings.backendUrl;
    this.ignoredSpeakerInput.value = settings.ignoredSpeakerName ?? "";
    this.promptModeSelect.value = settings.promptMode;
    this.autoDetectInput.checked = settings.autoDetect;
    if (settings.overlaySize) {
      this.setSize(settings.overlaySize.width, settings.overlaySize.height);
    }
    if (settings.overlayPosition) {
      this.setPosition(settings.overlayPosition.left, settings.overlayPosition.top);
    }
  }

  showDetectedQuestion(question: string): void {
    this.setQuestion(question);
    if (!this.manualInput.value.trim()) {
      this.manualInput.value = question;
    }
    this.setStatus("Detected interviewer question. Click Analyze transcript to ask Claude.");
  }

  setDraft(input: string, status: string): void {
    this.clearError();
    this.manualInput.value = input;
    this.setQuestion(input);
    this.setStatus(status);
  }

  setLoading(question: string): void {
    this.clearError();
    this.setQuestion(question);
    this.setStatus("Generating suggestion...");
    this.analyzeButton.disabled = true;
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

  setAnswer(response: AnalyzeResponse): void {
    this.analyzeButton.disabled = false;
    this.clearError();
    this.answerBox.hidden = false;
    const answerSlot = this.answerBox.querySelector('[data-slot="answer"]');
    if (answerSlot) {
      answerSlot.textContent = response.answer;
    }
    this.clearTranslation("answer");
    this.setStatus(`Suggestion ready from ${response.model}.`);
  }

  setError(message: string): void {
    this.analyzeButton.disabled = false;
    this.errorBox.hidden = false;
    this.errorBox.textContent = message;
    this.setStatus("Could not generate suggestion.");
  }

  focusManualInput(text?: string): void {
    if (this.minimized) {
      this.toggleMinimized();
    }
    if (text) {
      this.manualInput.value = text;
    }
    this.manualInput.focus();
  }

  get linesToGrab(): number {
    const val = Number.parseInt(this.linesInput.value, 10);
    return Number.isNaN(val) ? 1 : Math.min(Math.max(val, 1), 10);
  }

  autoFillIgnoredSpeaker(name: string): void {
    if (!this.ignoredSpeakerInput.value.trim()) {
      this.ignoredSpeakerInput.value = name;
    }
  }

  setDetached(hidden: boolean): void {
    this.root.hidden = hidden;
  }

  private bindEvents(): void {
    this.root.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      const actionButton = target.closest<HTMLElement>("[data-action]");
      if (actionButton) {
        const action = actionButton.dataset.action;
        if (
          action === "selection" ||
          action === "manual" ||
          action === "clear-history" ||
          action?.startsWith("translate-")
        ) {
          event.preventDefault();
        }
      }
    });

    this.root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (!action) {
        return;
      }

      if (action === "manual") {
        this.submitManual();
      }

      if (action === "selection") {
        this.submitSelection();
      }

      if (action === "clear-history") {
        this.handlers.onClearHistory?.();
      }

      if (action === "translate-question") {
        void this.translateSlot("question");
      }

      if (action === "translate-answer") {
        void this.translateSlot("answer");
      }

      if (action === "detach") {
        this.handlers.onDetachPanel?.();
      }

      if (action === "minimize") {
        this.toggleMinimized();
      }
    });

    this.backendInput.addEventListener("change", () => {
      this.handlers.onSettingsChange({ backendUrl: this.backendInput.value.trim() });
    });

    this.ignoredSpeakerInput.addEventListener("change", () => {
      this.handlers.onSettingsChange({
        ignoredSpeakerName: this.ignoredSpeakerInput.value.trim(),
      });
    });

    this.promptModeSelect.addEventListener("change", () => {
      this.handlers.onSettingsChange({
        promptMode:
          this.promptModeSelect.value === "multiple-speakers"
            ? "multiple-speakers"
            : "one-on-one",
      });
    });

    this.autoDetectInput.addEventListener("change", () => {
      this.handlers.onSettingsChange({ autoDetect: this.autoDetectInput.checked });
    });

    this.header.addEventListener("pointerdown", (event) => {
      if (this.options.detachedPanel) {
        return;
      }

      const target = event.target as HTMLElement;
      if (target.closest("button")) {
        return;
      }

      const rect = this.root.getBoundingClientRect();
      this.dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      this.header.setPointerCapture(event.pointerId);
      this.root.dataset.dragging = "true";
      event.preventDefault();
    });

    this.header.addEventListener("pointermove", (event) => {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
        return;
      }

      this.setPosition(
        event.clientX - this.dragState.offsetX,
        event.clientY - this.dragState.offsetY,
      );
    });

    this.header.addEventListener("pointerup", (event) => {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
        return;
      }

      this.finishDrag();
    });

    this.header.addEventListener("pointercancel", () => {
      this.finishDrag();
    });

    this.header.addEventListener("dblclick", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("button")) {
        return;
      }

      this.root.style.left = "";
      this.root.style.top = "";
      this.root.style.transform = "";
      this.handlers.onSettingsChange({ overlayPosition: undefined });
    });

    this.resizeHandle.addEventListener("pointerdown", (event) => {
      if (this.options.detachedPanel) {
        return;
      }

      if (this.minimized) {
        return;
      }

      const rect = this.root.getBoundingClientRect();
      this.setPosition(rect.left, rect.top);
      this.resizeState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: rect.width,
        startHeight: rect.height,
      };
      this.resizeHandle.setPointerCapture(event.pointerId);
      this.root.dataset.resizing = "true";
      event.preventDefault();
    });

    this.resizeHandle.addEventListener("pointermove", (event) => {
      if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) {
        return;
      }

      this.setSize(
        this.resizeState.startWidth + event.clientX - this.resizeState.startX,
        this.resizeState.startHeight + event.clientY - this.resizeState.startY,
      );
      this.keepInViewport();
    });

    this.resizeHandle.addEventListener("pointerup", (event) => {
      if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) {
        return;
      }

      this.finishResize();
    });

    this.resizeHandle.addEventListener("pointercancel", () => {
      this.finishResize();
    });
  }

  private submitManual(): void {
    const question = this.manualInput.value.trim();
    this.handlers.onAnalyze(question, "manual");
  }

  private submitSelection(): void {
    this.handlers.onPickTranscript();
  }

  private toggleMinimized(): void {
    this.minimized = !this.minimized;
    this.root.dataset.minimized = String(this.minimized);
    if (!this.minimized) {
      this.keepInViewport();
    }
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
    const textSlot = this.root.querySelector(`[data-slot="${slotName}"]`);
    const text = textSlot?.textContent?.trim() ?? "";
    if (!text) {
      return;
    }

    if (!this.handlers.onTranslateText) {
      this.setTranslation(slotName, "Không có chức năng dịch.");
      return;
    }

    this.setTranslation(slotName, "Đang dịch...");
    try {
      const translation = await this.handlers.onTranslateText(text);
      this.setTranslation(slotName, translation);
    } catch (error) {
      this.setTranslation(
        slotName,
        error instanceof Error ? error.message : "Không dịch được đoạn này.",
      );
    }
  }

  private setTranslation(slotName: "question" | "answer", translation: string): void {
    const translationSlot = this.root.querySelector(
      `[data-slot="${slotName}-translation"]`,
    );
    if (!translationSlot) {
      return;
    }

    translationSlot.textContent = translation;
    (translationSlot as HTMLElement).hidden = false;
  }

  private clearTranslation(slotName: "question" | "answer"): void {
    const translationSlot = this.root.querySelector(
      `[data-slot="${slotName}-translation"]`,
    );
    if (!translationSlot) {
      return;
    }

    translationSlot.textContent = "";
    (translationSlot as HTMLElement).hidden = true;
  }

  private setPosition(left: number, top: number): void {
    const rect = this.root.getBoundingClientRect();
    const nextLeft = Math.min(
      Math.max(left, CopilotOverlay.VIEWPORT_MARGIN),
      Math.max(
        window.innerWidth - rect.width - CopilotOverlay.VIEWPORT_MARGIN,
        CopilotOverlay.VIEWPORT_MARGIN,
      ),
    );
    const nextTop = Math.min(
      Math.max(top, CopilotOverlay.VIEWPORT_MARGIN),
      Math.max(
        window.innerHeight - rect.height - CopilotOverlay.VIEWPORT_MARGIN,
        CopilotOverlay.VIEWPORT_MARGIN,
      ),
    );

    this.root.style.left = `${nextLeft}px`;
    this.root.style.top = `${nextTop}px`;
    this.root.style.transform = "none";
  }

  private setSize(width: number, height: number): void {
    const rect = this.root.getBoundingClientRect();
    const left = rect.left || CopilotOverlay.VIEWPORT_MARGIN;
    const top = rect.top || CopilotOverlay.VIEWPORT_MARGIN;
    const maxWidth = Math.max(
      CopilotOverlay.MIN_WIDTH,
      window.innerWidth - left - CopilotOverlay.VIEWPORT_MARGIN,
    );
    const maxHeight = Math.max(
      CopilotOverlay.MIN_HEIGHT,
      window.innerHeight - top - CopilotOverlay.VIEWPORT_MARGIN,
    );
    const nextWidth = Math.min(
      Math.max(width, CopilotOverlay.MIN_WIDTH),
      maxWidth,
    );
    const nextHeight = Math.min(
      Math.max(height, CopilotOverlay.MIN_HEIGHT),
      maxHeight,
    );

    this.root.style.width = `${Math.round(nextWidth)}px`;
    this.root.style.height = `${Math.round(nextHeight)}px`;
    this.root.style.maxHeight = "none";
  }

  private keepInViewport(): void {
    const rect = this.root.getBoundingClientRect();
    this.setPosition(rect.left, rect.top);
  }

  private finishDrag(): void {
    const rect = this.root.getBoundingClientRect();
    this.dragState = undefined;
    delete this.root.dataset.dragging;
    this.handlers.onSettingsChange({
      overlayPosition: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      },
    });
  }

  private finishResize(): void {
    const rect = this.root.getBoundingClientRect();
    this.resizeState = undefined;
    delete this.root.dataset.resizing;
    this.handlers.onSettingsChange({
      overlaySize: {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      overlayPosition: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      },
    });
  }
}

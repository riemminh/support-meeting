import type { AnalyzeResponse, MeetingSettings } from "./types";

export interface OverlayHandlers {
  onAnalyze(input: string): void;
  onPickTranscript(): void;
  onSettingsChange(settings: Partial<MeetingSettings>): void;
  onClearHistory?(): void;
  onDetachPanel?(): void;
  onTranslateText?(text: string): Promise<string>;
}

export interface OverlayOptions {
  detachedPanel?: boolean;
}

export class MeetingOverlay {
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
  private readonly contextSearchInput: HTMLInputElement;
  private readonly contextBox: HTMLDivElement;
  private readonly selectedLinesCount: HTMLSpanElement;
  private readonly header: HTMLDivElement;
  private readonly resizeHandle: HTMLDivElement;
  private currentContextLines: string[] = [];
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
    this.root.setAttribute("aria-label", "Teams Meeting");

    this.root.innerHTML = `
      <div class="tic-header">
        <div class="tic-header-copy">
          <div class="tic-title">Teams Meeting Assistant</div>
          <div class="tic-subtitle">Ask questions, summarize, or extract action items from this meeting.</div>
        </div>
        <div class="tic-header-actions">
          <details class="tic-settings-menu">
            <summary>Settings</summary>
            <div class="tic-settings-dropdown">
              <div class="tic-settings">
                <input class="tic-url" type="url" aria-label="Backend URL" placeholder="Backend URL" />
                <select class="tic-prompt-mode" aria-label="Prompt mode">
                  <option value="one-on-one">1-1 prompt</option>
                  <option value="multiple-speakers">Multiple speakers</option>
                </select>
                <input class="tic-speaker" type="text" aria-label="Ignore speaker" placeholder="Ignore speaker (your Teams name)" />
                <div class="tic-settings-row">
                  <label class="tic-checkbox">
                    <input type="checkbox" class="tic-auto-detect" />
                    Prepare latest
                  </label>
                  <button class="tic-button tic-button-sm" data-action="clear-history" title="Clear conversation history">Clear History</button>
                </div>
              </div>
            </div>
          </details>
          <button class="tic-icon-button" data-action="detach" title="${this.options.detachedPanel ? "Show in-page overlay" : "Open in panel"}" aria-label="${this.options.detachedPanel ? "Show in-page overlay" : "Open in panel"}">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6h12"/></svg>
          </button>
          <button class="tic-icon-button" data-action="minimize" title="Minimize" aria-label="Minimize">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="8" x2="13" y2="8"/></svg>
          </button>
        </div>
      </div>
      <div class="tic-body">
        <div class="tic-workspace">

          <!-- ── Left: Transcript ── -->
          <section class="tic-side tic-context-panel" aria-label="Transcript context">
            <div class="tic-panel-header">
              <div class="tic-section-title">Transcript</div>
              <span class="tic-context-footer" style="border:none;padding:0;">
                <span data-slot="selected-lines">0</span> lines
              </span>
            </div>
            <div class="tic-context-search-wrap">
              <input class="tic-context-search" type="search" placeholder="Search transcript…" aria-label="Search transcript" />
            </div>
            <div class="tic-context-list" data-slot="context"></div>
          </section>

          <!-- ── Right: Ask & Answer ── -->
          <section class="tic-side tic-qa-panel" aria-label="Ask and answer">

            <!-- Ask block -->
            <div class="tic-ask-section">
              <div class="tic-ask-label">Ask about this meeting</div>
              <textarea class="tic-input" placeholder="How would you apply that in frontend work?" rows="2"></textarea>
              <div class="tic-action-row">
                <button class="tic-button tic-button-primary" data-action="manual">Ask AI</button>
                <button class="tic-button" data-action="selection">Use selected</button>
                <label class="tic-lines-control" title="Number of latest transcript lines to include">
                  <span>Lines</span>
                  <input class="tic-lines" type="number" min="1" max="10" value="1" aria-label="Lines to grab" />
                </label>
              </div>
            </div>

            <!-- Status -->
            <div class="tic-status"></div>

            <!-- Question card (compact) -->
            <div class="tic-question" hidden>
              <div class="tic-question-header">
                <div class="tic-label" style="color:var(--tic-accent-2)">You asked</div>
                <button class="tic-translate-button" data-action="translate-question">Dịch</button>
              </div>
              <div data-slot="question"></div>
              <div class="tic-translation" data-slot="question-translation" hidden></div>
            </div>

            <!-- Answer card -->
            <div class="tic-answer" hidden>
              <div class="tic-box-header">
                <div class="tic-label">Answer</div>
                <button class="tic-translate-button" data-action="translate-answer">Dịch</button>
              </div>
              <div class="tic-answer-body" data-slot="answer"></div>
              <div class="tic-translation" data-slot="answer-translation" hidden></div>
              <div class="tic-answer-footer">
                <span class="tic-answer-source" data-slot="answer-source">Sources: current context</span>
                <div class="tic-answer-actions">
                  <button class="tic-button tic-button-sm" data-action="copy-answer">Copy</button>
                  <button class="tic-button tic-button-sm" data-action="regenerate">Regenerate</button>
                </div>
              </div>
            </div>

            <!-- Error -->
            <div class="tic-error" hidden></div>

          </section>
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
    this.contextSearchInput = this.root.querySelector(
      ".tic-context-search",
    ) as HTMLInputElement;
    this.contextBox = this.root.querySelector(
      '[data-slot="context"]',
    ) as HTMLDivElement;
    this.selectedLinesCount = this.root.querySelector(
      '[data-slot="selected-lines"]',
    ) as HTMLSpanElement;
    this.header = this.root.querySelector(".tic-header") as HTMLDivElement;
    this.resizeHandle = this.root.querySelector(
      ".tic-resize-handle",
    ) as HTMLDivElement;
    this.analyzeButton = this.root.querySelector(
      '[data-action="manual"]',
    ) as HTMLButtonElement;

    this.bindEvents();
    this.renderContextLines();
    document.documentElement.appendChild(this.root);
    if (this.options.detachedPanel) {
      this.root.dataset.panel = "true";
    }
  }

  setSettings(settings: MeetingSettings): void {
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
          action === "copy-answer" ||
          action === "regenerate" ||
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

      if (action === "copy-answer") {
        void this.copyAnswer();
      }

      if (action === "regenerate") {
        this.regenerateAnswer();
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

    this.contextSearchInput.addEventListener("input", () => {
      this.renderContextLines();
    });

    this.header.addEventListener("pointerdown", (event) => {
      if (this.options.detachedPanel) {
        return;
      }

      const target = event.target as HTMLElement;
      if (target.closest("button, summary, input, select, label, textarea")) {
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
      if (target.closest("button, summary, input, select, label, textarea")) {
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
    this.handlers.onAnalyze(question);
  }

  private submitSelection(): void {
    this.handlers.onPickTranscript();
  }

  private regenerateAnswer(): void {
    const questionSlot = this.questionBox.querySelector('[data-slot="question"]');
    const question =
      this.manualInput.value.trim() || questionSlot?.textContent?.trim() || "";
    if (question) {
      this.manualInput.value = question;
    }
    this.handlers.onAnalyze(question);
  }

  private async copyAnswer(): Promise<void> {
    const answerSlot = this.answerBox.querySelector('[data-slot="answer"]');
    const answer = answerSlot?.textContent?.trim() ?? "";
    if (!answer) {
      return;
    }

    try {
      await navigator.clipboard.writeText(answer);
      this.setStatus("Answer copied.");
    } catch {
      this.setError("Could not copy answer.");
    }
  }

  private toggleMinimized(): void {
    this.minimized = !this.minimized;
    this.root.dataset.minimized = String(this.minimized);
    if (!this.minimized) {
      this.keepInViewport();
    }
  }

  private setQuestion(question: string): void {
    this.setContext(question);
    this.questionBox.hidden = false;
    const questionSlot = this.questionBox.querySelector('[data-slot="question"]');
    if (questionSlot) {
      questionSlot.textContent = question;
    }
    this.clearTranslation("question");
  }

  private setContext(text: string): void {
    const lines = text
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    this.currentContextLines = lines.length > 0 ? lines : text.trim() ? [text.trim()] : [];
    this.renderContextLines();
  }

  private renderContextLines(): void {
    const filter = this.contextSearchInput.value.trim().toLocaleLowerCase();
    const rows = this.currentContextLines
      .map((text, index) => ({ text, index }))
      .filter((row) => !filter || row.text.toLocaleLowerCase().includes(filter));

    this.contextBox.replaceChildren();
    this.selectedLinesCount.textContent = String(this.currentContextLines.length);

    if (this.currentContextLines.length === 0) {
      const placeholder = document.createElement("div");
      placeholder.className = "tic-context-empty";
      placeholder.textContent = "Use selected text or paste transcript to load context.";
      this.contextBox.appendChild(placeholder);
      return;
    }

    if (rows.length === 0) {
      const placeholder = document.createElement("div");
      placeholder.className = "tic-context-empty";
      placeholder.textContent = "No matching transcript lines.";
      this.contextBox.appendChild(placeholder);
      return;
    }

    for (const row of rows) {
      const line = document.createElement("div");
      line.className = "tic-context-line";

      const index = document.createElement("span");
      index.className = "tic-context-index";
      index.textContent = String(row.index + 1).padStart(2, "0");

      const text = document.createElement("span");
      text.className = "tic-context-text";
      text.textContent = row.text;

      line.append(index, text);
      this.contextBox.appendChild(line);
    }
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
      Math.max(left, MeetingOverlay.VIEWPORT_MARGIN),
      Math.max(
        window.innerWidth - rect.width - MeetingOverlay.VIEWPORT_MARGIN,
        MeetingOverlay.VIEWPORT_MARGIN,
      ),
    );
    const nextTop = Math.min(
      Math.max(top, MeetingOverlay.VIEWPORT_MARGIN),
      Math.max(
        window.innerHeight - rect.height - MeetingOverlay.VIEWPORT_MARGIN,
        MeetingOverlay.VIEWPORT_MARGIN,
      ),
    );

    this.root.style.left = `${nextLeft}px`;
    this.root.style.top = `${nextTop}px`;
    this.root.style.transform = "none";
  }

  private setSize(width: number, height: number): void {
    const rect = this.root.getBoundingClientRect();
    const left = rect.left || MeetingOverlay.VIEWPORT_MARGIN;
    const top = rect.top || MeetingOverlay.VIEWPORT_MARGIN;
    const maxWidth = Math.max(
      MeetingOverlay.MIN_WIDTH,
      window.innerWidth - left - MeetingOverlay.VIEWPORT_MARGIN,
    );
    const maxHeight = Math.max(
      MeetingOverlay.MIN_HEIGHT,
      window.innerHeight - top - MeetingOverlay.VIEWPORT_MARGIN,
    );
    const nextWidth = Math.min(
      Math.max(width, MeetingOverlay.MIN_WIDTH),
      maxWidth,
    );
    const nextHeight = Math.min(
      Math.max(height, MeetingOverlay.MIN_HEIGHT),
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

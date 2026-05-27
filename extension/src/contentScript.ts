import { CopilotOverlay } from "./overlay";
import type {
  AnalyzeRequest,
  AnalyzeStreamMessage,
  BackgroundAnalyzeReply,
  BackgroundMessage,
  CopilotSettings,
  ChatMessage,
} from "./types";

const MAX_QUESTION_LENGTH = 700;
const DEDUPE_TTL_MS = 90_000;
const SCAN_DEBOUNCE_MS = 600;
const DEFAULT_SETTINGS: CopilotSettings = {
  backendUrl: "http://localhost:8787",
  autoDetect: true,
  ignoredSpeakerName: "",
  overlayPosition: undefined,
};

const transcriptSelectors = [
  "[data-tid*='caption' i]",
  "[data-tid*='transcript' i]",
  "[data-tid*='chat' i]",
  "[aria-label*='caption' i]",
  "[aria-label*='transcript' i]",
  "[aria-label*='chat' i]",
  "[role='log']",
  "[role='listitem']",
  "[role='article']",
];

const questionLeadIns = [
  /^(can|could|would|will|do|does|did|are|is|have|has|how|what|when|where|why|who|which)\b/i,
  /^(tell me|walk me|describe|explain)\b/i,
  /\b(can you|could you|would you|tell me about|walk me through|describe a time|how would you|what would you|why should we|what makes you)\b/i,
];

let settings: CopilotSettings = DEFAULT_SETTINGS;
let observer: MutationObserver | undefined;
let scanTimer: number | undefined;
const recentlySeen = new Map<string, number>();
let conversationHistory: ChatMessage[] = [];

interface TranscriptEntry {
  speaker?: string;
  text: string;
}

const overlay = new CopilotOverlay({
  onAnalyze: (input, source) => {
    void analyzeTranscriptOrQuestion(input, source);
  },
  onPickTranscript: () => {
    pickTranscriptIntoOverlay();
  },
  onSettingsChange: (nextSettings) => {
    settings = { ...settings, ...nextSettings };
    sendMessage({ type: "SAVE_SETTINGS", payload: nextSettings }).catch(() => {
      overlay.setError("Could not save extension settings.");
    });
  },
  onClearHistory: () => {
    conversationHistory = [];
    overlay.setError(""); // Clear any errors
    overlay.setDraft("", "Conversation history cleared.");
  },
});

void initialize();

async function initialize(): Promise<void> {
  settings = await getSettings();
  overlay.setSettings(settings);
  autoDetectOwnName();
  installHotkeys();
  startTranscriptObserver();
}

function autoDetectOwnName(): void {
  const avatarImg = document.querySelector("img.fui-Avatar__image[src*='displayname=']");
  if (avatarImg) {
    const src = avatarImg.getAttribute("src") ?? "";
    try {
      const url = new URL(src, location.href);
      const displayName = url.searchParams.get("displayname");
      if (displayName) {
        const decodedName = decodeURIComponent(displayName);
        const currentIgnored = settings.ignoredSpeakerName ?? "";
        if (!currentIgnored.trim()) {
          overlay.autoFillIgnoredSpeaker(decodedName);
          settings.ignoredSpeakerName = decodedName;
          sendMessage({ type: "SAVE_SETTINGS", payload: { ignoredSpeakerName: decodedName } }).catch(() => {});
        }
      }
    } catch {
      const match = src.match(/[?&]displayname=([^&]+)/);
      if (match && match[1]) {
        const decodedName = decodeURIComponent(match[1]);
        const currentIgnored = settings.ignoredSpeakerName ?? "";
        if (!currentIgnored.trim()) {
          overlay.autoFillIgnoredSpeaker(decodedName);
          settings.ignoredSpeakerName = decodedName;
          sendMessage({ type: "SAVE_SETTINGS", payload: { ignoredSpeakerName: decodedName } }).catch(() => {});
        }
      }
    }
  }
}

function installHotkeys(): void {
  window.addEventListener(
    "keydown",
    (event) => {
      const isLegacyAnalyze = event.altKey && event.shiftKey && event.code === "KeyA";
      const isMacAnalyze = event.metaKey && event.shiftKey && event.code === "KeyK";
      const isFocusManual =
        (event.altKey && event.shiftKey && event.code === "KeyM") ||
        (event.metaKey && event.shiftKey && event.code === "KeyL");

      if (isLegacyAnalyze || isMacAnalyze) {
        const selected = window.getSelection()?.toString().trim();
        event.preventDefault();
        pickTranscriptIntoOverlay(selected);
        return;
      }

      if (isFocusManual) {
        event.preventDefault();
        overlay.focusManualInput(window.getSelection()?.toString().trim());
      }
    },
    true,
  );
}

function startTranscriptObserver(): void {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver(() => {
    if (!settings.autoDetect) {
      return;
    }
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanVisibleTeamsText, SCAN_DEBOUNCE_MS);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  scanVisibleTeamsText();
}

function scanVisibleTeamsText(): void {
  if (!settings.autoDetect) {
    return;
  }

  const latestQuestion = getLatestOpposingTranscriptQuestion();
  const question = latestQuestion ? extractLikelyQuestion(latestQuestion.text) : undefined;
  if (question && !isDuplicate(question)) {
    markSeen(question);
    overlay.showDetectedQuestion(question);
  }
}

function getLatestVisibleTranscriptText(): string | undefined {
  return getLatestOpposingTranscriptEntry()?.text;
}

function getLatestNOpposingEntries(n: number): TranscriptEntry[] {
  const entries = collectVisibleTranscriptEntries();
  const opposingEntries = entries.filter((entry) => !isIgnoredSpeaker(entry.speaker));

  const lastN = opposingEntries.slice(-n);

  const grouped: TranscriptEntry[] = [];
  for (const entry of lastN) {
    const prev = grouped[grouped.length - 1];
    if (prev && normalizeSpeakerName(prev.speaker ?? "") === normalizeSpeakerName(entry.speaker ?? "")) {
      prev.text = `${prev.text} ${entry.text}`;
    } else {
      grouped.push({
        speaker: entry.speaker,
        text: entry.text,
      });
    }
  }

  return grouped;
}

function getLatestOpposingTranscriptEntry(): TranscriptEntry | undefined {
  const entries = collectVisibleTranscriptEntries();
  const latestEntry = [...entries].reverse().find((entry) => {
    return !isIgnoredSpeaker(entry.speaker);
  });

  if (latestEntry) {
    return latestEntry;
  }

  const fallback = [...collectVisibleTextCandidates()].reverse()[0];
  return fallback ? { text: fallback } : undefined;
}

function getLatestOpposingTranscriptQuestion(): TranscriptEntry | undefined {
  const entries = collectVisibleTranscriptEntries();
  
  // First, try to find the latest opposing speaker entry that is a question
  const latestQuestion = [...entries].reverse().find((entry) => {
    if (isIgnoredSpeaker(entry.speaker)) {
      return false;
    }
    return Boolean(extractLikelyQuestion(entry.text));
  });

  if (latestQuestion) {
    return latestQuestion;
  }

  // Second, fall back to the absolute latest entry from the opposing speaker (even if not strictly a question)
  const latestEntry = [...entries].reverse().find((entry) => {
    return !isIgnoredSpeaker(entry.speaker);
  });

  if (latestEntry) {
    return latestEntry;
  }

  const fallback = [...collectVisibleTextCandidates()]
    .reverse()
    .find((candidate) => Boolean(extractLikelyQuestion(candidate)));
  return fallback ? { text: fallback } : undefined;
}

function collectVisibleTranscriptEntries(): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const seen = new Set<string>();

  // 1. Query MS Teams specific closed-caption text elements first.
  // This helps directly pair each speaker name with their specific caption text and avoids duplicate entries.
  const captionTexts = document.querySelectorAll("[data-tid='closed-caption-text']");
  for (const textNode of captionTexts) {
    if (textNode.closest(".tic-overlay") || !isVisibleElement(textNode)) {
      continue;
    }

    const text = normalizeTranscriptText(textNode.textContent ?? "");
    if (!text || looksLikeUrlOrNavigationNoise(text)) {
      continue;
    }

    let speaker: string | undefined;
    const container = textNode.closest(".fui-ChatMessageCompact");
    if (container) {
      const authorNode = container.querySelector("[data-tid='author']");
      if (authorNode) {
        speaker = normalizeTranscriptText(authorNode.textContent ?? "");
      }
    }

    const key = `${normalizeSpeakerName(speaker ?? "")}:${text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({ speaker, text });
  }

  // 2. Fall back to generic transcript selectors if no specific MS Teams closed captions were found
  if (entries.length === 0) {
    const nodes = new Set<Element>();
    for (const selector of transcriptSelectors) {
      document.querySelectorAll(selector).forEach((node) => nodes.add(node));
    }

    for (const node of nodes) {
      if (node.closest(".tic-overlay") || !isVisibleElement(node)) {
        continue;
      }

      const rawText =
        "innerText" in node
          ? ((node as HTMLElement).innerText ?? "")
          : (node.textContent ?? "");

      for (const entry of parseTranscriptEntries(rawText)) {
        if (looksLikeUrlOrNavigationNoise(entry.text)) {
          continue;
        }

        const key = `${normalizeSpeakerName(entry.speaker ?? "")}:${entry.text}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        entries.push(entry);
      }
    }
  }

  return entries;
}

function parseTranscriptEntries(rawText: string): TranscriptEntry[] {
  const rawLines = rawText
    .split(/\n+/)
    .map((line) => normalizeTranscriptText(line))
    .filter(Boolean)
    .filter((line) => !isTranscriptUiNoise(line));

  const lines = rawLines.filter((line, index) => {
    const next = rawLines[index + 1];
    return !(isAvatarInitials(line) && next && isLikelySpeakerName(next));
  });

  if (lines.length === 0) {
    return [];
  }

  const colonMatch = normalizeTranscriptText(rawText).match(
    /^([^:]{2,60}):\s*(.{2,})$/,
  );
  if (colonMatch && isLikelySpeakerName(colonMatch[1])) {
    return [
      {
        speaker: colonMatch[1],
        text: colonMatch[2],
      },
    ];
  }

  const entries: TranscriptEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const speaker = lines[index];
    const next = lines[index + 1];
    if (!next || !isLikelySpeakerName(speaker)) {
      continue;
    }

    const messageLines: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (cursor > index + 1 && isLikelySpeakerName(line)) {
        break;
      }
      messageLines.push(line);
    }

    const text = normalizeTranscriptText(messageLines.join(" "));
    if (text.length > 2) {
      entries.push({ speaker, text });
      index += messageLines.length;
    }
  }

  if (entries.length > 0) {
    return entries;
  }

  return [
    {
      text: normalizeTranscriptText(rawText),
    },
  ];
}

function collectVisibleTextCandidates(): string[] {
  const nodes = new Set<Element>();
  for (const selector of transcriptSelectors) {
    document.querySelectorAll(selector).forEach((node) => nodes.add(node));
  }

  return Array.from(nodes)
    .filter((node) => !node.closest(".tic-overlay"))
    .filter(isVisibleElement)
    .map((node) => normalizeTranscriptText(node.textContent ?? ""))
    .filter(
      (text) =>
        text.length > 8 &&
        text.length < 1_500 &&
        !looksLikeUrlOrNavigationNoise(text),
    );
}

function extractLikelyQuestion(text: string): string | undefined {
  const cleaned = normalizeTranscriptText(text);
  if (!cleaned || looksLikeUrlOrNavigationNoise(cleaned)) {
    return undefined;
  }

  const speakerStripped = cleaned.replace(
    /^(interviewer|recruiter|hiring manager|host|participant|speaker\s*\d+|[^:]{1,40}):\s*/i,
    "",
  );

  const segments = speakerStripped
    .split(/(?<=[?.!])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const directQuestion = [...segments]
    .reverse()
    .find((segment) => isLikelyInterviewerQuestion(segment));
  if (directQuestion) {
    return clampQuestion(directQuestion);
  }

  if (isLikelyInterviewerQuestion(speakerStripped)) {
    return clampQuestion(speakerStripped);
  }

  return undefined;
}

function clampQuestion(question: string): string {
  const cleaned = normalizeTranscriptText(question);
  return cleaned.length > MAX_QUESTION_LENGTH
    ? `${cleaned.slice(0, MAX_QUESTION_LENGTH).trim()}...`
    : cleaned;
}

function normalizeTranscriptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isTranscriptUiNoise(text: string): boolean {
  return /^(rtt|live captions|type a message|invite people|search|chat|people|raise|react|view|controls|notes|apps|more|camera|mic|share|leave)$/i.test(
    text,
  );
}

function isLikelySpeakerName(text: string): boolean {
  const cleaned = normalizeTranscriptText(text);
  if (cleaned.length < 2 || cleaned.length > 60) {
    return false;
  }

  if (/[?!.]$/.test(cleaned) || looksLikeUrlOrNavigationNoise(cleaned)) {
    return false;
  }

  return /^[\p{L}][\p{L}\p{M} .'-]{1,59}$/u.test(cleaned);
}

function isAvatarInitials(text: string): boolean {
  return /^[A-Z]{1,4}$/.test(text.trim());
}

function isIgnoredSpeaker(speaker?: string): boolean {
  const ignoredSpeaker = normalizeSpeakerName(settings.ignoredSpeakerName ?? "");
  if (!speaker || !ignoredSpeaker) {
    return false;
  }
  return normalizeSpeakerName(speaker) === ignoredSpeaker;
}

function normalizeSpeakerName(speaker: string): string {
  return speaker.toLowerCase().replace(/\s+/g, " ").trim();
}

function isLikelyInterviewerQuestion(text: string): boolean {
  const cleaned = normalizeTranscriptText(text);
  if (!cleaned || looksLikeUrlOrNavigationNoise(cleaned)) {
    return false;
  }

  const words = cleaned.match(/[a-z]+/gi) ?? [];
  const isDirectQuestion = cleaned.endsWith("?");
  const minWords = isDirectQuestion ? 3 : 5;
  if (words.length < minWords) {
    return false;
  }

  const rejectedPatterns = [
    /\*{2,}/,
    /^(am|was|were|do|did|have|can|could|should|would)\s+i\b/i,
    /^(ok|okay|yeah|yep|wait|right|hello|hi)\b/i,
    /\b(wait,?\s*wait|there we go|bigger|save the phone question)\b/i,
  ];

  if (rejectedPatterns.some((pattern) => pattern.test(cleaned))) {
    return false;
  }

  return questionLeadIns.some((pattern) => pattern.test(cleaned));
}

function looksLikeUrlOrNavigationNoise(text: string): boolean {
  const compact = text.trim();
  const urlPatterns = [
    /^https?:\/\//i,
    /^\/\//,
    /\bhttps?:\/\//i,
    /\b[a-z0-9-]+\.(com|net|org|io|dev|app|microsoft|atlassian)\b/i,
    /\/wiki\/|\/pages\/|draftShareId=|[?&][a-z0-9_-]+=/i,
  ];

  if (urlPatterns.some((pattern) => pattern.test(compact))) {
    return true;
  }

  const slashCount = (compact.match(/\//g) ?? []).length;
  return slashCount >= 3;
}

function isVisibleElement(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  const rect = htmlElement.getBoundingClientRect();
  const style = window.getComputedStyle(htmlElement);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}

function isDuplicate(question: string): boolean {
  pruneSeenQuestions();
  return recentlySeen.has(fingerprint(question));
}

function markSeen(question: string): void {
  recentlySeen.set(fingerprint(question), Date.now());
}

function pruneSeenQuestions(): void {
  const now = Date.now();
  for (const [key, createdAt] of recentlySeen.entries()) {
    if (now - createdAt > DEDUPE_TTL_MS) {
      recentlySeen.delete(key);
    }
  }
}

function fingerprint(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9? ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function analyzeQuestion(
  question: string,
  source: AnalyzeRequest["source"],
): void {
  const normalizedQuestion = clampQuestion(question);
  if (!normalizedQuestion) {
    return;
  }

  markSeen(normalizedQuestion);
  overlay.setLoading(normalizedQuestion);

  const payload: AnalyzeRequest = {
    question: normalizedQuestion,
    history: conversationHistory,
    source,
    pageUrl: location.href,
    detectedAt: new Date().toISOString(),
  };

  streamAnalyzeQuestion(payload);
}

async function analyzeTranscriptOrQuestion(
  input: string,
  source: AnalyzeRequest["source"],
): Promise<void> {
  const candidate = input.trim() || getLatestVisibleTranscriptText() || "";
  
  const question = candidate;

  if (!question.trim()) {
    overlay.setError(
      "No selected text or visible interviewer question found. Select transcript text, paste it here, or wait for a question in RTT/chat.",
    );
    return;
  }

  analyzeQuestion(question, source);
}

function streamAnalyzeQuestion(payload: AnalyzeRequest): void {
  const port = chrome.runtime.connect({ name: "ANALYZE_STREAM" });
  let model: string | undefined;
  let accumulatedAnswer = "";

  overlay.startAnswerStream(payload.question);

  port.onMessage.addListener((message: AnalyzeStreamMessage) => {
    if (message.type === "start") {
      model = message.model;
      return;
    }

    if (message.type === "delta") {
      accumulatedAnswer += message.text;
      overlay.appendAnswerDelta(message.text);
      return;
    }

    if (message.type === "done") {
      overlay.finishAnswerStream(model);
      if (accumulatedAnswer.trim()) {
        saveToConversationHistory(payload.question, accumulatedAnswer.trim());
      }
      port.disconnect();
      return;
    }

    if (message.type === "error") {
      overlay.setError(message.error);
      port.disconnect();
    }
  });

  port.postMessage({ type: "START", payload });
}

function saveToConversationHistory(question: string, answer: string): void {
  conversationHistory.push({ role: "user", content: question });
  conversationHistory.push({ role: "assistant", content: answer });

  const MAX_HISTORY_TURNS = 5;
  if (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY_TURNS * 2);
  }
}

function pickTranscriptIntoOverlay(selectedText?: string): void {
  const selected = selectedText ?? window.getSelection()?.toString().trim() ?? "";
  
  if (selected) {
    overlay.setDraft(
      selected,
      "Selection loaded. Click Analyze transcript when you want to ask Claude.",
    );
    return;
  }

  const n = overlay.linesToGrab;
  const entries = getLatestNOpposingEntries(n);

  if (entries.length === 0) {
    overlay.setError(
      "No visible question or transcript from the other speaker found. Select transcript text or set Ignore speaker to your Teams name.",
    );
    return;
  }

  let question = "";
  if (n === 1) {
    const entry = entries[0];
    question = entry.speaker ? `${entry.speaker}: ${entry.text}` : entry.text;
  } else {
    question = entries
      .map((entry) => {
        if (entry.speaker) {
          return `${entry.speaker}: ${entry.text}`;
        }
        return entry.text;
      })
      .join("\n");
  }

  if (!question.trim()) {
    overlay.setError(
      "No visible question or transcript from the other speaker found. Select transcript text or set Ignore speaker to your Teams name.",
    );
    return;
  }

  overlay.setDraft(
    question,
    "Transcript loaded. Click Analyze transcript when you want to ask Claude.",
  );
}

async function getSettings(): Promise<CopilotSettings> {
  return sendMessage<CopilotSettings>({ type: "GET_SETTINGS" }).catch(
    () => DEFAULT_SETTINGS,
  );
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

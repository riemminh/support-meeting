import { MeetingOverlay } from "./overlay";
import type {
  AnalyzeRequest,
  AnalyzeStreamMessage,
  BackgroundAnalyzeReply,
  BackgroundTranslateReply,
  BackgroundMessage,
  MeetingSettings,
  ChatMessage,
  ContentScriptMessage,
  LatestTranscriptReply,
} from "./types";

const MAX_QUESTION_LENGTH = 700;
const MAX_AUTO_TURN_ENTRIES = 6;
const DEDUPE_TTL_MS = 90_000;
const SCAN_DEBOUNCE_MS = 600;
const DEFAULT_SETTINGS: MeetingSettings = {
  backendUrl: "http://localhost:8787",
  autoDetect: true,
  promptMode: "one-on-one",
  ignoredSpeakerName: "",
  overlayPosition: undefined,
  overlaySize: undefined,
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
  /^(?:(?:and|also|but|so|then|next|now)\s+)?(can|could|would|will|do|does|did|are|is|have|has|how|what|when|where|why|who|which)\b/i,
  /^(?:(?:and|also|but|so|then|next|now|please)\s+)?(tell me|walk me|describe|explain|give me|share|talk about)\b/i,
  /\b(can you|could you|would you|tell me about|walk me through|describe a time|how would you|what would you|why should we|what makes you|what about|how about|i want you to|i'd like you to|please explain|please describe)\b/i,
];

let settings: MeetingSettings = DEFAULT_SETTINGS;
let observer: MutationObserver | undefined;
let scanTimer: number | undefined;
const recentlySeen = new Map<string, number>();
let conversationHistory: ChatMessage[] = [];

interface TranscriptEntry {
  speaker?: string;
  text: string;
}

const overlay = new MeetingOverlay({
  onAnalyze: (input) => {
    void analyzeTranscriptOrQuestion(input);
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
  onDetachPanel: () => {
    openDetachedPanel();
  },
  onTranslateText: (text) => {
    return translateText(text);
  },
});

void initialize();

async function initialize(): Promise<void> {
  settings = await getSettings();
  overlay.setSettings(settings);
  autoDetectOwnName();
  installHotkeys();
  installSettingsListener();
  startTranscriptObserver();
  installRuntimeMessageHandlers();
}

function installSettingsListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    const nextSettings: Partial<MeetingSettings> = {};
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
      overlay.setSettings(settings);
    }
  });
}

function installRuntimeMessageHandlers(): void {
  chrome.runtime.onMessage.addListener(
    (
      message: ContentScriptMessage,
      _sender,
      sendResponse: (response: LatestTranscriptReply | { ok: true }) => void,
    ) => {
      if (message.type === "READ_LATEST_TRANSCRIPT") {
        sendResponse(readLatestTranscriptForPanel(message.linesToGrab));
        return false;
      }

      if (message.type === "SET_IN_PAGE_OVERLAY_VISIBLE") {
        overlay.setDetached(!message.visible);
        sendResponse({ ok: true });
        return false;
      }

      return false;
    },
  );
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

function getLatestNOpposingEntries(
  n: number,
  options: { groupConsecutiveTurns?: boolean } = {},
): TranscriptEntry[] {
  const { groupConsecutiveTurns = true } = options;
  const entries = collectVisibleTranscriptEntries();
  const opposingEntries = entries.filter((entry) => !isIgnoredSpeaker(entry.speaker));

  const lastN = opposingEntries.slice(-n);
  if (!groupConsecutiveTurns) {
    return lastN;
  }

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

  const latestQuestionTurn = getLatestOpposingQuestionTurn(entries);
  if (latestQuestionTurn) {
    return latestQuestionTurn;
  }

  // Fall back to the absolute latest entry from the opposing speaker (even if not strictly a question).
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

function getLatestOpposingQuestionTurn(
  entries: TranscriptEntry[],
): TranscriptEntry | undefined {
  const latestTurn = getLatestOpposingTurn(entries);
  if (latestTurn && extractLikelyQuestion(latestTurn.text)) {
    return latestTurn;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isIgnoredSpeaker(entry.speaker)) {
      continue;
    }

    if (extractLikelyQuestion(entry.text)) {
      return buildTranscriptTurnEndingAt(entries, index);
    }
  }

  return undefined;
}

function getLatestOpposingTurn(entries: TranscriptEntry[]): TranscriptEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!isIgnoredSpeaker(entries[index].speaker)) {
      return buildTranscriptTurnEndingAt(entries, index);
    }
  }

  return undefined;
}

function buildTranscriptTurnEndingAt(
  entries: TranscriptEntry[],
  endIndex: number,
): TranscriptEntry {
  const endEntry = entries[endIndex];
  const speakerKey = normalizeSpeakerName(endEntry.speaker ?? "");
  const turnEntries: TranscriptEntry[] = [];

  for (
    let cursor = endIndex;
    cursor >= 0 && turnEntries.length < MAX_AUTO_TURN_ENTRIES;
    cursor -= 1
  ) {
    const entry = entries[cursor];
    if (isIgnoredSpeaker(entry.speaker)) {
      break;
    }

    const currentSpeakerKey = normalizeSpeakerName(entry.speaker ?? "");
    if (speakerKey && currentSpeakerKey !== speakerKey) {
      break;
    }

    if (!speakerKey && currentSpeakerKey) {
      break;
    }

    turnEntries.unshift(entry);
  }

  return {
    speaker: endEntry.speaker,
    text: normalizeTranscriptText(turnEntries.map((entry) => entry.text).join(" ")),
  };
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
    if (!text || isTranscriptUiNoise(text) || looksLikeUrlOrNavigationNoise(text)) {
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
        if (isTranscriptUiNoise(entry.text) || looksLikeUrlOrNavigationNoise(entry.text)) {
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

  const colonLineEntries = lines
    .map((line): TranscriptEntry | undefined => {
      const lineMatch = line.match(/^([^:]{2,60}):\s*(.{2,})$/);
      if (!lineMatch || !isLikelySpeakerName(lineMatch[1])) {
        return undefined;
      }

      return {
        speaker: lineMatch[1],
        text: lineMatch[2],
      };
    })
    .filter((entry): entry is TranscriptEntry => Boolean(entry));

  if (colonLineEntries.length > 0 && colonLineEntries.length === lines.length) {
    return colonLineEntries;
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
        !isTranscriptUiNoise(text) &&
        !looksLikeUrlOrNavigationNoise(text),
    );
}

function extractLikelyQuestion(text: string): string | undefined {
  const cleaned = normalizeTranscriptText(text);
  if (!cleaned || isTranscriptUiNoise(cleaned) || looksLikeUrlOrNavigationNoise(cleaned)) {
    return undefined;
  }

  const speakerStripped = stripSpeakerPrefix(cleaned);
  const currentTurn = stripLeadingQuestionFiller(speakerStripped);

  const segments = currentTurn
    .split(/(?<=[?.!])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const firstQuestionIndex = segments.findIndex((segment) =>
    isLikelyInterviewerQuestion(segment),
  );
  if (firstQuestionIndex >= 0) {
    return clampQuestion(segments.slice(firstQuestionIndex).join(" "));
  }

  if (isLikelyInterviewerQuestion(currentTurn)) {
    return clampQuestion(currentTurn);
  }

  return undefined;
}

function stripSpeakerPrefix(text: string): string {
  return normalizeTranscriptText(text).replace(
    /^(interviewer|recruiter|hiring manager|host|participant|speaker\s*\d+|[^:]{1,40}):\s*/i,
    "",
  );
}

function stripLeadingQuestionFiller(text: string): string {
  return normalizeTranscriptText(text)
    .replace(
      /^(?:(?:ok|okay|yeah|yep|right|alright|all right|sure|thanks|thank you|so|well|got it|cool|great|nice|hi|hello)(?:\s+riem)?[,.\s]+)+/i,
      "",
    )
    .trim();
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
  const cleaned = normalizeTranscriptText(text);
  if (!cleaned) {
    return true;
  }

  const exactNoise =
    /^(rtt|live captions|type a message|invite people|search|chat|chats|meeting chat|meeting chats|people|raise|react|view|controls|notes|apps|more|camera|mic|microphone|share|leave|question|suggested answer)$/i;

  const phraseNoise = [
    /^(\d+\s*)+new notifications?$/i,
    /\bhas context menu\b/i,
    /\bmeeting chats?\b/i,
    /\bnew notifications?\b/i,
    /\bnew chat\b/i,
    /\bopen chat\b/i,
    /\bstart recording\b/i,
    /\bturn camera\b/i,
    /\bmute microphone\b/i,
  ];

  return exactNoise.test(cleaned) || phraseNoise.some((pattern) => pattern.test(cleaned));
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

  const candidate = stripLeadingQuestionFiller(cleaned);
  if (!candidate) {
    return false;
  }

  const words = candidate.match(/[a-z]+/gi) ?? [];
  const isDirectQuestion = candidate.endsWith("?");
  const minWords =
    isDirectQuestion && isShortFollowUpQuestion(candidate)
      ? 1
      : isDirectQuestion
        ? 3
        : 5;
  if (words.length < minWords) {
    return false;
  }

  const rejectedPatterns = [
    /\*{2,}/,
    /^(am|was|were|do|did|have|can|could|should|would)\s+i\b/i,
    /^(wait)\b/i,
    /\b(wait,?\s*wait|there we go|bigger|save the phone question)\b/i,
  ];

  if (rejectedPatterns.some((pattern) => pattern.test(candidate))) {
    return false;
  }

  return questionLeadIns.some((pattern) => pattern.test(candidate));
}

function isShortFollowUpQuestion(text: string): boolean {
  const compact = normalizeTranscriptText(text).replace(/[?!.]+$/, "").trim();
  return /^(?:(?:and|also|but|so|then|next|now)\s+)?(why|how|what|when|where|who|which)$/i.test(
    compact,
  );
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

function analyzeQuestion(question: string): void {
  const normalizedQuestion = clampQuestion(question);
  if (!normalizedQuestion) {
    return;
  }

  markSeen(normalizedQuestion);
  overlay.setLoading(normalizedQuestion);

  const payload: AnalyzeRequest = {
    question: normalizedQuestion,
    history: conversationHistory,
    promptMode: settings.promptMode,
    pageUrl: location.href,
    detectedAt: new Date().toISOString(),
  };

  streamAnalyzeQuestion(payload);
}

async function analyzeTranscriptOrQuestion(input: string): Promise<void> {
  const candidate = input.trim() || getLatestVisibleTranscriptText() || "";
  const question = extractCurrentInterviewTurn(candidate) ?? "";

  if (!question.trim()) {
    overlay.setError(
      "No selected text or visible interviewer question found. Select transcript text, paste it here, or wait for a question in RTT/chat.",
    );
    return;
  }

  analyzeQuestion(question);
}

function readLatestTranscriptForPanel(linesToGrab = 1): LatestTranscriptReply {
  const normalizedLinesToGrab = Math.min(Math.max(linesToGrab, 1), 10);
  const selected = cleanTranscriptBlock(window.getSelection()?.toString() ?? "");
  if (selected) {
    return { ok: true, question: selected };
  }

  if (normalizedLinesToGrab > 1) {
    const latestEntries = formatTranscriptEntries(
      getLatestNOpposingEntries(normalizedLinesToGrab, {
        groupConsecutiveTurns: false,
      }),
    );

    if (latestEntries.trim()) {
      return { ok: true, question: latestEntries };
    }
  }

  const candidate =
    getLatestOpposingTranscriptQuestion()?.text || getLatestVisibleTranscriptText() || "";
  const question = extractCurrentInterviewTurn(candidate);

  if (!question?.trim()) {
    return {
      ok: false,
      error:
        "No visible interviewer question found in the Teams tab. Select transcript text or wait for a question.",
    };
  }

  return { ok: true, question };
}

function formatTranscriptEntries(entries: TranscriptEntry[]): string {
  return entries
    .map((entry) => {
      if (entry.speaker) {
        return `${entry.speaker}: ${entry.text}`;
      }

      return entry.text;
    })
    .join("\n");
}

function cleanTranscriptBlock(text: string): string | undefined {
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeTranscriptText(line))
    .filter(
      (line) =>
        line &&
        !isTranscriptUiNoise(line) &&
        !looksLikeUrlOrNavigationNoise(line),
    );

  const cleaned = lines.join("\n").trim();
  if (!cleaned || isTranscriptUiNoise(cleaned) || looksLikeUrlOrNavigationNoise(cleaned)) {
    return undefined;
  }

  return cleaned;
}

function openDetachedPanel(): void {
  sendMessage<{ ok: true } | { ok: false; error: string }>({
    type: "OPEN_DETACHED_PANEL",
  })
    .then((reply) => {
      if (reply.ok) {
        overlay.setDetached(true);
        return;
      }

      overlay.setError(reply.error);
    })
    .catch((error: unknown) => {
      overlay.setError(
        error instanceof Error ? error.message : "Could not open separate window.",
      );
    });
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

function extractCurrentInterviewTurn(input: string): string | undefined {
  const cleaned = normalizeTranscriptText(input);
  if (!cleaned || isTranscriptUiNoise(cleaned) || looksLikeUrlOrNavigationNoise(cleaned)) {
    return undefined;
  }

  const parsedEntries = parseTranscriptEntries(input);
  if (parsedEntries.length > 1 || parsedEntries.some((entry) => entry.speaker)) {
    const latestQuestionTurn = getLatestOpposingQuestionTurn(parsedEntries);
    if (latestQuestionTurn) {
      return (
        extractLikelyQuestion(latestQuestionTurn.text) ??
        clampQuestion(latestQuestionTurn.text)
      );
    }
  }

  return extractLikelyQuestion(cleaned) ?? clampQuestion(cleaned);
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
  const selected = cleanTranscriptBlock(
    selectedText ?? window.getSelection()?.toString() ?? "",
  );
  
  if (selected) {
    overlay.setDraft(
      selected,
      "Selection loaded. Click Analyze transcript when you want to ask Claude.",
    );
    return;
  }

  const n = overlay.linesToGrab;
  const entries = getLatestNOpposingEntries(n, {
    groupConsecutiveTurns: n === 1,
  });

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

async function getSettings(): Promise<MeetingSettings> {
  return sendMessage<MeetingSettings>({ type: "GET_SETTINGS" }).catch(
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

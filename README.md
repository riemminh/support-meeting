# Teams Meeting Copilot

Chrome Extension Manifest V3 plus a local TypeScript backend for Microsoft Teams Web meeting help.

The extension reads visible Teams RTT/transcript/chat text from the DOM, detects likely meeting questions, and sends only that single question to a local backend. The backend calls Claude through the Anthropic SDK and returns a short answer suggestion for the extension overlay.

It does not capture audio, run speech-to-text, use Microsoft Graph, use the Teams bot API, or send the full meeting transcript to Claude.

## Project Layout

```text
teams-interview-copilot/
  extension/
    package.json
    tsconfig.json
    vite.config.ts
    manifest.json
    src/
      contentScript.ts
      background.ts
      overlay.ts
      overlay.css
      types.ts
  backend/
    package.json
    tsconfig.json
    .env.example
    src/
      server.ts
      providers/
        LLMProvider.ts
        AnthropicProvider.ts
      prompts/
        interviewPrompt.ts
```

## Backend Setup

```bash
cd backend
npm install
cp .env.example .env
```

Edit `backend/.env` and set:

```bash
ANTHROPIC_API_KEY=sk-ant-your-real-key
ANTHROPIC_MODEL=claude-3-5-sonnet-20240620
PORT=8787
HOST=127.0.0.1
```

Run the backend:

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:8787/health
```

Analyze one question:

```bash
curl -X POST http://localhost:8787/analyze \
  -H "Content-Type: application/json" \
  -d '{"question":"Can you walk me through a challenging project you led?","source":"manual","detectedAt":"2026-05-27T00:00:00.000Z"}'
```

## Extension Setup

```bash
cd extension
npm install
npm run build
```

Load the extension in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `teams-interview-copilot/extension/dist`.
5. Open Microsoft Teams Web at `https://teams.microsoft.com`, `https://teams.live.com`, or `https://teams.cloud.microsoft`.

## Usage

The overlay appears on Teams pages. It supports:

- Auto detection of visible RTT/transcript/chat questions through a `MutationObserver`.
- Manual transcript or question entry in the overlay. The extension extracts the likely interviewer question locally before sending to the backend.
- Selected visible transcript/chat text with the Use selection button. This only loads text into the overlay; it does not call Claude.
- `Ignore speaker` can be set to your Teams display name so the latest-question picker prefers the other speaker.
- Mac hotkey `Command+Shift+K` to load selected text or the latest visible transcript question.
- Mac hotkey `Command+Shift+L` to focus the manual input.
- Legacy hotkey `Alt+Shift+A` to analyze selected text.
- Legacy hotkey `Alt+Shift+M` to focus the manual input.

Only clicking Analyze transcript sends one detected/manually selected question to the local backend. The extension uses `http://localhost:8787/analyze/stream` for streamed answers, while `http://localhost:8787/analyze` remains available for non-streaming checks. The Anthropic API key remains in the backend `.env` file and is never included in the Chrome extension.

## Privacy Boundary

- Reads visible DOM text only from Teams Web pages matched by the manifest.
- Does not capture microphone or tab audio.
- Does not run speech recognition.
- Does not call Microsoft Graph or Teams bot APIs.
- Deduplicates recently detected questions to avoid repeated backend calls.
- Backend rejects likely bulk transcripts and caps question length at 700 characters.

## Build Checks

```bash
cd backend
npm run typecheck
npm run build

cd ../extension
npm run typecheck
npm run build
```

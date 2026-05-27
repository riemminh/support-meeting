# Teams Interview Copilot - Agent Handoff Knowledge

## Mục tiêu sản phẩm

Teams Interview Copilot là một Chrome Extension Manifest V3 chạy trên Microsoft Teams Web. Extension đọc text RTT/transcript/chat đang hiển thị trong DOM, phát hiện câu hỏi của interviewer, gửi duy nhất câu hỏi đó về backend local, backend gọi Claude qua Anthropic SDK, rồi trả gợi ý trả lời để hiển thị trên overlay.

Các giới hạn quan trọng của sản phẩm:

- Không capture audio.
- Không speech-to-text.
- Không dùng Microsoft Graph API.
- Không dùng Teams bot API.
- Không gửi toàn bộ transcript lên Claude.
- API key Anthropic chỉ nằm trong backend `.env`, tuyệt đối không nằm trong extension.
- Extension chỉ đọc text visible từ DOM Teams và chỉ gửi câu hỏi đã detect hoặc text user chọn thủ công.

## Cấu trúc thư mục

```text
teams-interview-copilot/
  .gitignore
  README.md
  AGENT_HANDOFF.md

  extension/
    manifest.json
    package.json
    package-lock.json
    tsconfig.json
    vite.config.ts
    src/
      background.ts
      contentScript.ts
      overlay.ts
      overlay.css
      types.ts

  backend/
    .env.example
    package.json
    package-lock.json
    tsconfig.json
    src/
      server.ts
      providers/
        LLMProvider.ts
        AnthropicProvider.ts
      prompts/
        interviewPrompt.ts
```

## Luồng dữ liệu chính

1. User mở Microsoft Teams Web trong Chrome.
2. Chrome inject `contentScript.js` và `overlay.css` theo rule trong `extension/manifest.json`.
3. `contentScript.ts` tạo overlay bằng `CopilotOverlay`.
4. `MutationObserver` trong content script theo dõi thay đổi DOM.
5. Content script gom text visible từ các selector liên quan caption/transcript/chat/log/list item/article.
6. Logic `extractLikelyQuestion()` tìm câu hỏi trực tiếp có dấu `?` hoặc câu bắt đầu bằng các lead-in như `can`, `could`, `how`, `what`, `tell me`, `walk me`, `describe`, `explain`.
7. Câu hỏi được normalize, giới hạn tối đa 700 ký tự và dedupe trong 90 giây.
8. Content script gửi message `ANALYZE_QUESTION` sang background service worker.
9. `background.ts` đọc setting backend URL từ `chrome.storage.sync`, gọi `POST /analyze`.
10. Backend validate request, từ chối payload rỗng/quá dài/có vẻ là bulk transcript.
11. `AnthropicProvider` gọi Claude bằng `@anthropic-ai/sdk` streaming (`stream: true`) khi extension dùng `/analyze/stream`.
12. Backend trả từng NDJSON delta về background service worker.
13. Background đẩy delta qua `chrome.runtime.Port` cho content script.
14. Extension hiển thị answer dần trong overlay.

## Extension

### `manifest.json`

Manifest V3 với:

- `permissions`: `storage`, `activeTab`.
- `host_permissions`: Teams Web domains phổ biến và `http://localhost:8787/*`.
- Background service worker: `background.js`, type module.
- Content script match Teams Web, inject `contentScript.js` và `overlay.css`.

Không có permission microphone/audio/tabCapture vì sản phẩm không capture audio.

### `src/types.ts`

Định nghĩa contract dùng chung trong extension:

- `AnalyzeRequest`: payload gửi backend, gồm `question`, `source`, `pageUrl`, `detectedAt`.
- `AnalyzeResponse`: response hợp lệ từ backend.
- `CopilotSettings`: `backendUrl`, `autoDetect`.
- `BackgroundMessage`: union type cho message giữa content script và background.

Nếu sửa API contract backend, cập nhật file này trước để TypeScript bắt mismatch.

### `src/contentScript.ts`

Đây là nơi chứa business logic phía Teams page:

- Khởi tạo settings mặc định:
  - `backendUrl = "http://localhost:8787"`
  - `autoDetect = true`
- Tạo overlay.
- Cài hotkeys:
  - `Command+Shift+K`: Mac primary hotkey, load selected text or latest visible transcript question into the overlay.
  - `Command+Shift+L`: Mac primary hotkey, focus manual input.
  - `Alt+Shift+A`: legacy analyze selected visible text.
  - `Alt+Shift+M`: legacy focus manual input.
- Cài `MutationObserver` trên `document.body`.
- Scan text từ DOM qua `transcriptSelectors`.
- Chỉ nhận element visible qua `getBoundingClientRect()` và computed style.
- Normalize whitespace.
- Detect câu hỏi bằng:
  - câu có `?`
  - lead-in regex cho dạng câu hỏi/phỏng vấn không có dấu hỏi.
- Dedupe bằng fingerprint lowercase, bỏ ký tự lạ, TTL 90 giây.
- Gửi duy nhất question đã clamp về background.

Rủi ro khi mở rộng:

- Teams DOM thay đổi thường xuyên. Nếu auto-detect yếu, ưu tiên cập nhật `transcriptSelectors`.
- Selector quá rộng có thể đọc nhiều text UI không liên quan. Luôn giữ filter visible + length + question heuristic.
- Không thêm logic gom nhiều dòng transcript thành payload dài nếu chưa có guard privacy.

### `src/background.ts`

Service worker làm cầu nối network:

- Lưu/đọc settings trong `chrome.storage.sync`.
- Nhận `GET_SETTINGS`, `SAVE_SETTINGS`, `ANALYZE_QUESTION`.
- Gọi backend `/analyze`.
- Validate shape response runtime bằng `isAnalyzeResponse()`.
- Trả lỗi dạng `{ ok: false, error }` để content script hiển thị.

Lý do network đi qua background: content script giữ UI/DOM logic, background giữ trách nhiệm gọi backend và settings.

### `src/overlay.ts` và `src/overlay.css`

Overlay vanilla TS/CSS:

- Manual textarea.
- Button analyze manual transcript/question.
- Button use selection.
- Ignore speaker input. User can enter their Teams display name so DOM picking prefers the other speaker.
- Backend URL input.
- Auto detect checkbox.
- Status, question box, answer box, error box.
- Minimize button.

Overlay gọi callback do content script truyền vào:

- `onAnalyze(input, source)`
- `onSettingsChange(settings)`

Không gọi backend trực tiếp trong overlay.

### Build extension

`extension/vite.config.ts` build hai entry:

- `contentScript.ts` -> `dist/contentScript.js`
- `background.ts` -> `dist/background.js`

Plugin custom copy:

- `manifest.json` -> `dist/manifest.json`
- `src/overlay.css` -> `dist/overlay.css`

Chrome load unpacked từ `extension/dist`.

## Backend

### `src/server.ts`

Express server local:

- Load `.env` bằng `dotenv/config`.
- Bắt buộc có `ANTHROPIC_API_KEY`.
- Default:
  - `PORT=8787`
  - `HOST=127.0.0.1`
  - `MAX_QUESTION_LENGTH=700`
- CORS cho:
  - request không có origin, ví dụ curl.
  - `chrome-extension:` origins.
  - `http://localhost`.
  - `http://127.0.0.1`.
  - origins liệt kê trong `ALLOWED_ORIGIN`.
- JSON body limit: `16kb`.

Endpoints:

- `GET /health`: trả `{ ok: true }`.
- `POST /analyze`: nhận một câu hỏi, validate, gọi provider, trả answer non-streaming.
- `POST /analyze/stream`: nhận một câu hỏi, validate, gọi Anthropic streaming, trả NDJSON events `start`, `delta`, `done`, `error`.

Validation `/analyze`:

- `question` phải là string không rỗng.
- tối đa 700 ký tự.
- từ chối nếu có vẻ là bulk transcript:
  - có ít nhất 3 speaker labels kiểu `Name:`.
  - hoặc có ít nhất 8 sentence breaks.

### `providers/LLMProvider.ts`

Interface trừu tượng cho provider LLM:

- input: `{ question }`
- output: `{ answer, model, usage }`

Nếu sau này đổi Claude sang provider khác, implement interface này thay vì sửa toàn bộ server.

### `providers/AnthropicProvider.ts`

Provider hiện tại dùng `@anthropic-ai/sdk`:

- Model mặc định: `claude-3-5-sonnet-20240620`.
- Có thể override bằng `ANTHROPIC_MODEL`.
- `max_tokens = 700`.
- `temperature = 0.35`.
- Dùng `messages.create()`.
- Ghép các content block type `text` thành answer.

API key truyền từ server vào constructor, không bao giờ expose ra extension.

### `prompts/interviewPrompt.ts`

Prompt chia thành:

- `buildInterviewSystemPrompt()`: vai trò interview copilot, câu trả lời tự nhiên, không nhắc AI/transcript.
- `buildInterviewUserPrompt(question)`: chỉ chứa câu hỏi interview và yêu cầu output 4-8 bullet/short paragraphs.

Nếu chỉnh style câu trả lời, ưu tiên sửa file này.

## Privacy và Security Boundaries

Các boundary phải giữ khi phát triển tiếp:

- Extension không có Anthropic API key.
- Extension không gọi Anthropic trực tiếp.
- Không thêm permission audio/microphone/tabCapture.
- Không thêm Microsoft Graph hoặc Teams Bot API.
- Không gửi full transcript.
- Auto-detect chỉ gửi một câu hỏi đã normalize/clamp/dedupe.
- Manual/selection flow chỉ gửi text user nhập hoặc text visible user chọn.
- Backend là chốt chặn cuối: validate length và reject likely bulk transcript.
- Backend bind local `127.0.0.1` mặc định.

## Business Logic Chi Tiết

### Question detection

Nguồn text:

- `data-tid` chứa caption/transcript/chat.
- `aria-label` chứa caption/transcript/chat.
- `role=log`.
- `role=listitem`.
- `role=article`.

Pipeline:

1. Collect matching elements.
2. Filter visible.
3. Normalize whitespace.
4. Bỏ item quá ngắn hoặc quá dài.
5. Strip speaker prefix nếu có.
6. Split theo sentence boundary.
7. Ưu tiên segment có `?`.
8. Nếu không có `?`, check lead-in regex.
9. Clamp 700 chars.
10. Dedupe 90 giây.

### Manual mode

Manual mode nhận transcript hoặc câu hỏi. Chỉ khi user bấm Analyze transcript thì content script chạy `extractLikelyQuestion()`; nếu tìm được câu hỏi trong transcript thì chỉ gửi câu hỏi đó. Nếu không tìm được, nó fallback sang input thủ công đã clamp. Source là `"manual"`.

### Selection mode

Selection mode chỉ load `window.getSelection().toString().trim()` vào overlay. Nếu không có selection, content script tìm câu hỏi mới nhất từ speaker khác `ignoredSpeakerName`. Mode này không gửi Claude; user phải bấm Analyze transcript để gửi. Đây là cách tốt nhất khi Teams DOM selector chưa bắt đúng transcript.

### Auto-detect mode

Auto-detect chạy khi `settings.autoDetect = true`. MutationObserver debounce 600ms để tránh spam khi DOM thay đổi liên tục.

## Các lệnh hữu ích

Backend:

```bash
cd teams-interview-copilot/backend
npm install
cp .env.example .env
npm run dev
npm run typecheck
npm run build
```

Extension:

```bash
cd teams-interview-copilot/extension
npm install
npm run typecheck
npm run build
```

Load Chrome extension từ:

```text
teams-interview-copilot/extension/dist
```

## Điểm cần chú ý khi agent khác tiếp tục

- Nếu cần cải thiện accuracy, bắt đầu từ `contentScript.ts`: selectors, visible filtering, regex question detection.
- Nếu cần cải thiện UI, sửa `overlay.ts` và `overlay.css`, nhưng giữ overlay không gọi backend trực tiếp.
- Nếu cần đổi model/prompt, sửa `.env` hoặc `interviewPrompt.ts`.
- Nếu cần đổi provider, tạo provider mới implement `LLMProvider`.
- Nếu cần thêm test, ưu tiên unit test cho:
  - `extractLikelyQuestion()`
  - dedupe/fingerprint
  - backend request validation
  - CORS allowed origin logic

## Trạng thái build gần nhất

Các check đã từng pass trong quá trình scaffold:

- `backend npm run typecheck`
- `backend npm run build`
- `backend npm audit --audit-level=moderate`
- `extension npm run typecheck`
- `extension npm run build`
- `extension npm audit --audit-level=moderate`
- backend smoke test `/health` trả `{ "ok": true }`

Nếu clone mới, cần chạy lại các lệnh trên vì `node_modules/` và `dist/` đã được đưa vào `.gitignore`.

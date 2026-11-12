# ⚡ BLACKBOX — The Localhost Flight Recorder
### Causal Cross-Boundary Time-Travel Bug Capsule System for Developers & AI Coding Agents
> **Browser DOM ↔ HTTP/WS Network ↔ Backend Terminal `stdout`/`stderr` ↔ Local Source Code AST ↔ Uncommitted Git Diff**

---

## 💡 What is BLACKBOX?
When a bug happens on `localhost`, the evidence is fragmented across four completely disconnected silos:
1. **The Browser (Plane I):** DOM state, user clicks, console errors, storage baselines.
2. **The Network (Plane II):** Full HTTP request/response headers, status codes, JSON payloads, and latency.
3. **The Terminal & Source Code (Plane III):** Backend terminal `stdout`/`stderr` streams and unhandled runtime stack traces across Node.js, Python, Go, and Rust.
4. **The Editor & Git Working Tree (Plane IV):** Uncommitted file modifications and dirty working-tree diffs.

Asking an AI coding agent to fix a bug without runtime telemetry forces it to guess blindly. Existing tools only see one side of the coin: Chrome DevTools is sandboxed inside the browser with **zero visibility** into your local terminal or backend code; terminal loggers only see backend text with **zero context** on what UI button the user clicked 12ms before the crash.

**BLACKBOX connects all four planes onto a single millisecond-accurate timeline.** It maintains an ultra-lightweight, lock-free **60-second rolling ring buffer** in RAM (`0` disk I/O until needed). The moment an unhandled error occurs, an HTTP `5xx` returns, or you press `Alt+Shift+B` / `Ctrl+B`, Blackbox freezes a permanent **`.blackbox.json` Time-Travel Bug Capsule** and serves the exact causal chain directly to you and your AI coding agent via **Model Context Protocol (MCP)**.

---

## 📦 Installation (Worldwide / Cross-Platform)

Requires **Node.js >= 18.0.0** (zero native C++ compilation dependencies; works out-of-the-box on Windows, macOS, and Linux).

### Option A: Global Install via npm / pnpm / npx
```bash
# Install globally via npm
npm install -g blackbox-flight-recorder

# Or install globally via pnpm
pnpm add -g blackbox-flight-recorder

# Or run immediately without installing via npx
npx blackbox-flight-recorder demo
```

### Option B: Install from Source Repository (1-Command Installer)
Clone the repository anywhere on your machine and run the cross-platform installer or `npm link`:

**macOS / Linux / WSL:**
```bash
git clone https://github.com/shourya-upadhyay/blackbox.git
cd blackbox
./install.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/shourya-upadhyay/blackbox.git
cd blackbox
.\install.ps1
```

**Manual Universal Link (Any OS):**
```bash
git clone https://github.com/shourya-upadhyay/blackbox.git
cd blackbox
npm install && npm link
```

Verify your installation at any time by running:
```bash
blackbox doctor
```

---

## 🚀 Quickstart in 60 Seconds

### 1. Launch the Interactive Demo Sandbox
Want to see Blackbox in action immediately? Run:
```bash
blackbox demo
```
This boots:
* **Blackbox Time-Travel Studio & Daemon:** `http://localhost:9876`
* **Target Sandbox App (NexusPay Checkout):** `http://localhost:4400`

Click any fault trigger in the sandbox (`http://localhost:4400`) to watch Blackbox automatically freeze a 60-second capsule, pinpoint the exact crashing line of code in the Source X-Ray, and compile a complete AI Root-Cause Diagnostic Dossier in under 400ms.

---

### 2. Onboard Your Own Project in 1 Command (`blackbox init`)
Navigate to **any** existing web or backend project (Next.js, Vite, React, Express, FastAPI, Django, Go, Rust) and run:
```bash
cd /path/to/your-project
blackbox init --inject
```
**What `blackbox init --inject` automatically configures for you:**
1. Creates `.blackbox/capsules/` for local bug capsule storage and adds `.blackbox/capsules/*.blackbox.json` to `.gitignore`.
2. Generates `.cursor/mcp.json` and `.mcp.json` so **Cursor**, **Claude Code**, **Windsurf**, and **Antigravity** automatically detect the Blackbox MCP server.
3. Injects the 1-line Browser Flight Recorder `<script>` tag into your frontend entry HTML (`index.html` or `public/index.html`) when `--inject` is passed.

---

### 3. Supervise Your Dev Server (`blackbox run`)
Wrap your normal start command with `blackbox run`:
```bash
# Supervise any dev command (captures stdout/stderr + auto-freezes on crash)
blackbox run "npm run dev" --name my-app

# Or attach the zero-config HTTP Wiretap Proxy (e.g. proxy port 4000 -> app port 3000)
blackbox run "npm run dev" --proxy 4000:3000
```
While running:
* Open `http://localhost:9876` to view the **Blackbox Time-Travel Studio** and **Live 60s Flight Deck**.
* Press **`Ctrl+B`** right inside your terminal or **`Alt+Shift+B`** in your browser at any moment to manually freeze the last 60 seconds of telemetry.

---

## ⌨️ Complete CLI Reference

| Command | Description |
| :--- | :--- |
| `blackbox init [--inject]` | Initialize Blackbox in the current project (`.blackbox`, `.gitignore`, MCP configs, optional HTML SDK injection) |
| `blackbox demo` | Launch Blackbox Studio (`:9876`) + Interactive NexusPay Sandbox (`:4400`) |
| `blackbox run "<cmd>" [--proxy IN:OUT]` | Supervise any dev server with 60s rolling flight recorder & optional HTTP wiretap proxy |
| `blackbox studio [--port 9876]` | Start the Blackbox Daemon & Time-Travel Studio UI standalone |
| `blackbox freeze [--title "..."]` | Freeze the active 60-second rolling buffer into a permanent `.blackbox.json` capsule |
| `blackbox capsules` | List all saved Time-Travel Bug Capsules in `.blackbox/capsules` |
| `blackbox inspect [id\|latest]` | Print the full Causal Fault Chain & AI Root-Cause Diagnostic Markdown to `stdout` |
| `blackbox mcp` | Start the stdio Model Context Protocol (MCP) JSON-RPC 2.0 server for AI coding agents |
| `blackbox doctor` | Run environment, port, vault, and live daemon health diagnostics |
| `blackbox --version` | Print installed Blackbox CLI version |

---

## 🔌 Browser Agent SDK (3 Flexible Options)

### Option A: Automatic Injection via `blackbox init --inject` or `--proxy`
Running `blackbox init --inject` adds the script tag to your HTML automatically, or running `blackbox run "<cmd>" --proxy 4000:3000` injects it on-the-fly into proxied HTML responses.

### Option B: Manual 1-Line `<script>` Tag
Add this single tag to your local HTML or root layout (`index.html`, `app/layout.tsx`):
```html
<script src="http://localhost:9876/sdk/browser-agent.js" data-blackbox-endpoint="http://localhost:9876"></script>
```

### Option C: Chrome / Edge Manifest V3 Extension (`extension/`)
Zero code changes required:
1. Open Chrome or Edge and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the [`extension/`](./extension) directory inside this repository
4. Every `localhost` and `127.0.0.1` tab is now automatically instrumented with the `Alt+Shift+B` Flight Recorder HUD!

---

## 🤖 MCP Server Setup (for Autonomous AI Coding Agents)

When you run `blackbox init`, `.cursor/mcp.json` and `.mcp.json` are generated automatically. You can also register Blackbox globally with Claude Code, Cursor, Windsurf, or Antigravity:

**Claude Code CLI:**
```bash
claude mcp add blackbox -- blackbox mcp
```

**Universal JSON Config (`.cursor/mcp.json` / `claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "blackbox": {
      "command": "blackbox",
      "args": ["mcp"]
    }
  }
}
```

### Available MCP Tools for AI Agents:
* `get_latest_crash_capsule`: Returns the full causal fault chain, UI click trigger, failed network payload, backend stack trace, local source code X-Ray snippet, and uncommitted Git diff.
* `list_capsules`: Lists all captured bug capsules with trigger reason, health status, and culprit `file:line`.
* `inspect_capsule_timeline`: Queries microsecond-indexed telemetry filtered by plane (`BROWSER`, `NETWORK`, `TERMINAL`, `GIT`).
* `freeze_live_buffer`: Triggers an immediate freeze of the live running 60-second flight recorder buffer.
* `diff_capsules`: Compares two capsules (`baselineId` vs `targetId`) to pinpoint HTTP status inversions, latency regressions, and newly introduced stack traces.

---

## 📦 Programmatic Node.js SDK
You can also embed Blackbox directly inside custom Node.js test runners or dev harnesses:
```javascript
import { BlackboxDaemonServer, ProcessSupervisor } from 'blackbox-flight-recorder';

const daemon = new BlackboxDaemonServer({ port: 9876, projectCwd: process.cwd() });
await daemon.start();
```

---

## 📄 License
[MIT](./LICENSE) © Shourya Upadhyay

# ⚡ KALA (काल) — The Localhost Flight Recorder
### Causal Cross-Boundary Time-Travel Bug Capsule System for Developers
> **Browser DOM ↔ HTTP/WS Network ↔ Backend Terminal `stdout`/`stderr` ↔ Local Source Code AST ↔ Uncommitted Git Diff**

---

## 💡 What is KALA?
When a bug happens on `localhost`, the evidence is fragmented across three completely disconnected silos:
1. **The Browser:** DOM state, user clicks, console errors, network request payloads.
2. **The Terminal:** Backend terminal logs, Docker logs, unhandled runtime stack traces.
3. **The Editor & Git:** Uncommitted file modifications and dirty working-tree diffs.

Existing tools only see one side of the coin: Chrome DevTools and Jam.dev are sandboxed inside the browser with **zero visibility** into your local terminal or backend code. Terminal loggers only see backend text with **zero context** on what UI button the user clicked 12ms before the crash.

**KALA connects all four planes onto a single millisecond-accurate timeline.** It maintains an ultra-lightweight, lock-free **60-second rolling ring buffer** in memory. The moment an unhandled error occurs, an HTTP `5xx` returns, or you press `Alt+Shift+B`, KALA freezes a permanent **`.kala.json` Bug Capsule**.

---

## 🚀 Key Architectural Superpowers

- **Lock-Free Multi-Plane Ring Buffer:** Microsecond-precision monotonic clock maintaining a bounded (default 60s / 64MB) rolling telemetry window across Browser, Network, Terminal, and Git.
- **Sticky DOM & Storage Baselines:** Retains the full initial DOM tree and localStorage/sessionStorage state so visual replay works even if the initial page load was 15 minutes ago.
- **Universal PTY / Stream Supervisor:** Wraps any backend dev command (`npm run dev`, `python manage.py`, `cargo run`, `go run`) with sub-millisecond ANSI stream chunk coalescing.
- **Local Source Code X-Ray:** Automatically parses stack frames from Node.js (V8), Python, Go, and Rust, resolves the local filesystem path on disk, and extracts the exact surrounding source code lines with the culprit line highlighted.
- **Git Working-Tree Overlap Correlation:** Inspects uncommitted Git diffs and cross-references crash stack traces against dirty hunks to identify whether recent uncommitted code introduced the bug.
- **4-Pane Blackbox Studio UI:** Synchronized dark-mode player with:
  1. Visual DOM Viewport & Laser Cursor Overlay
  2. Causal Network Waterfall & Payload Inspector
  3. Backend Terminal Stream & Source Code X-Ray
  4. Uncommitted Git Diff & AI Diagnostic Compiler
- **Built-in Model Context Protocol (MCP) Server:** Native stdio JSON-RPC 2.0 server (`kala-mcp`) allowing AI coding agents (Antigravity, Cursor, Claude Code, Zed) to diagnose bugs with zero prompt-engineering.
- **Capsule Differ & Regression Engine:** Differential comparison of two capsules to detect HTTP status regressions, latency shifts, and new backend exceptions.

---

## 🛠️ Quickstart

### 1. Run the Interactive Sandbox Demo
```bash
git clone https://github.com/your-username/kala.git
cd kala
npm install
npm run demo
```
This boots:
* **KALA Blackbox Studio & Daemon:** `http://localhost:9876`
* **Target Sandbox App (NexusPay):** `http://localhost:4400`

Click the crash button in the sandbox to watch KALA automatically freeze a capsule, highlight the root cause, and compile a complete diagnostic packet in under 400ms!

### 2. Supervise Your Own Project
```bash
# Supervise any dev command with KALA
npx kala run "npm run dev" --name my-api

# Or with the zero-config HTTP wiretap proxy:
npx kala run "npm run dev" --proxy 4000:3000
```

### 3. CLI Commands
```bash
kala demo                     # Launch Studio + Interactive Sandbox
kala studio                   # Start Blackbox Studio & Daemon standalone
kala run "<cmd>"              # Supervise a dev command
kala freeze [--title "..."]   # Freeze active rolling buffer immediately
kala capsules                 # List all saved bug capsules
kala inspect [id|latest]      # Print AI diagnostic packet for a capsule
kala mcp                      # Run stdio MCP Server for AI coding agents
```

---

## 🔌 Browser Agent SDK & Chrome Extension

### Option A: Automatic Wiretap Injection
When using `kala run "<cmd>" --proxy 4000:3000`, KALA automatically injects the browser agent into all HTML responses.

### Option B: Script Tag
Add this single tag to your local HTML/template:
```html
<script src="http://localhost:9876/sdk/browser-agent.js" data-kala-endpoint="http://localhost:9876"></script>
```

### Option C: Chrome Extension (Manifest V3)
1. Open Chrome/Edge and go to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `kala/extension` folder
4. Press `Alt+Shift+B` on any localhost page to freeze a capsule anytime!

---

## 🤖 MCP Server Setup (for AI Coding Agents)

Add KALA to your MCP config (`antigravity.json`, `claude_desktop_config.json`, or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "kala": {
      "command": "node",
      "args": ["C:/Users/Shourya Upadhyay/.gemini/antigravity/scratch/kala/bin/kala-mcp.js"],
      "env": {
        "KALA_PROJECT_CWD": "C:/path/to/your/project"
      }
    }
  }
}
```

### Available MCP Tools:
* `get_latest_crash_capsule`: Returns full causal chain, UI click, failed payload, backend stack trace, and local source code snippet.
* `list_capsules`: Lists captured bug capsules with trigger reason and culprit `file:line`.
* `inspect_capsule_timeline`: Queries microsecond-indexed telemetry by plane (`BROWSER`, `NETWORK`, `TERMINAL`).
* `freeze_live_buffer`: Triggers an immediate freeze of the live running flight recorder buffer.
* `diff_capsules`: Compares two capsules to detect status regressions and latency drift.

---

## 📄 License
MIT © Shourya Upadhyay

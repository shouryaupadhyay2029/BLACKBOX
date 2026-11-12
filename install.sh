#!/usr/bin/env bash
# ============================================================================
# BLACKBOX — Universal Installer for macOS, Linux & WSL
# Usage:
#   ./install.sh
#   or via npm: npm install -g blackbox-flight-recorder
# ============================================================================
set -euo pipefail

echo "⚡ Installing BLACKBOX — Localhost Flight Recorder & Causal Time-Travel Engine..."

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Error: Node.js (>= 18.0.0) is required. Install it from https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Error: Node.js >= 18.0.0 is required (found $(node -v))."
  exit 1
fi

if [ -f "package.json" ] && grep -q '"name": "blackbox-flight-recorder"' package.json 2>/dev/null; then
  echo "📦 Detected local Blackbox source repository. Installing dependencies and linking globally..."
  npm install
  npm link
else
  echo "🌐 Installing blackbox-flight-recorder globally via npm..."
  npm install -g blackbox-flight-recorder
fi

echo ""
echo "✅ BLACKBOX installed successfully!"
echo "   Run 'blackbox doctor' to verify your environment"
echo "   Run 'blackbox init' inside any project to configure MCP & telemetry"
echo "   Run 'blackbox demo' to launch the Studio Flight Deck (:9876) & Sandbox (:4400)"

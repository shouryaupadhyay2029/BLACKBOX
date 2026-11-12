# ============================================================================
# BLACKBOX — Universal Installer for Windows PowerShell
# Usage:
#   .\install.ps1
#   or via npm: npm install -g blackbox-flight-recorder
# ============================================================================
$ErrorActionPreference = "Stop"

Write-Host "⚡ Installing BLACKBOX — Localhost Flight Recorder & Causal Time-Travel Engine..." -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js (>= 18.0.0) is required. Install it from https://nodejs.org"
  exit 1
}

if (Test-Path ".\package.json") {
  $pkg = Get-Content ".\package.json" -Raw
  if ($pkg -match '"name":\s*"blackbox-flight-recorder"') {
    Write-Host "📦 Detected local Blackbox source repository. Installing dependencies and linking globally..." -ForegroundColor Yellow
    npm install
    npm link
  } else {
    Write-Host "🌐 Installing blackbox-flight-recorder globally via npm..." -ForegroundColor Yellow
    npm install -g blackbox-flight-recorder
  }
} else {
  Write-Host "🌐 Installing blackbox-flight-recorder globally via npm..." -ForegroundColor Yellow
  npm install -g blackbox-flight-recorder
}

Write-Host ""
Write-Host "✅ BLACKBOX installed successfully!" -ForegroundColor Green
Write-Host "   Run 'blackbox doctor' to verify your environment"
Write-Host "   Run 'blackbox init' inside any project to configure MCP & telemetry"
Write-Host "   Run 'blackbox demo' to launch the Studio Flight Deck (:9876) & Sandbox (:4400)"

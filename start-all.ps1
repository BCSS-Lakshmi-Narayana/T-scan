<#
    start-all.ps1 — bring up the whole t-scan application.

    Opens one window per service so a crash is visible and a restart is one
    window, not all of them. Checks Ollama first, because every other service
    degrades quietly without it rather than failing loudly.

        .\start-all.ps1                 # all five
        .\start-all.ps1 -NoFrontend     # services only
        .\start-all.ps1 -Check          # verify what is already running, start nothing

    Ports:  ollama 11434 | sentiment 8003 | rag 8100 | backend 8000 | ui 3000
#>
param(
    [switch] $NoFrontend,
    [switch] $Check
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Test-Port([int]$Port) {
    try { (New-Object Net.Sockets.TcpClient).Connect("127.0.0.1", $Port); return $true }
    catch { return $false }
}

function Show-State {
    Write-Host ""
    Write-Host "  SERVICE      PORT   STATE" -ForegroundColor Cyan
    foreach ($s in @(
        @{ n = "ollama";    p = 11434 },
        @{ n = "sentiment"; p = 8003 },
        @{ n = "rag";       p = 8100 },
        @{ n = "backend";   p = 8000 },
        @{ n = "frontend";  p = 3000 })) {
        $up = Test-Port $s.p
        $colour = if ($up) { "Green" } else { "DarkGray" }
        Write-Host ("  {0,-12} {1,-6} {2}" -f $s.n, $s.p, $(if ($up) { "up" } else { "down" })) -ForegroundColor $colour
    }
    Write-Host ""
}

if ($Check) { Show-State; exit 0 }

# --- Ollama -----------------------------------------------------------------
# Both the assistant and the sentiment service's intelligence stage use the
# SAME model (qwen2.5-7b-8k) on purpose: this GPU holds 8 GB and two models
# would evict each other on every alternating request.
if (-not (Test-Port 11434)) {
    Write-Host "Ollama is not running — start it first:  ollama serve" -ForegroundColor Yellow
    exit 1
}
Write-Host "Ollama is up." -ForegroundColor Green

function Start-Service-Window([string]$Title, [string]$Dir, [string]$Command) {
    Write-Host "starting $Title ..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-Command",
        "`$host.UI.RawUI.WindowTitle='$Title'; Set-Location '$Dir'; $Command"
    ) | Out-Null
}

# --- Sentiment (port 8003) --------------------------------------------------
# --workers 1 is deliberate: the tenant-fair LLM queue needs ONE process-wide
# gate, and two uvicorn workers are two independent processes with two gates.
# Allow ~2 minutes for IndicTrans2 + NLLB + RoBERTa to load before first use.
Start-Service-Window "tscan-sentiment" "$root\social_media_sentiment_analysis-multitennacy" `
    ".\.venv\Scripts\python.exe -m uvicorn api_server:app --host 127.0.0.1 --port 8003 --workers 1"

# --- RAG / AI assistant (port 8100) ----------------------------------------
# --workers 1 is REQUIRED, not a preference: progressive analysis keeps job
# state in process memory, so a second worker would serve a poll for a job it
# never saw. The service refuses to boot with more.
# 8100 is what the backend expects (RAG_API_URL); run.ps1's 8099 is not it.
Start-Service-Window "tscan-rag" "$root\RAG_pipline_saga" `
    ".\.venv\Scripts\python.exe -m uvicorn api_server:app --host 127.0.0.1 --port 8100 --workers 1"

# --- Node backend (port 8000) ----------------------------------------------
Start-Service-Window "tscan-backend" "$root\backend" "npm start"

# --- Frontend (port 3000) --------------------------------------------------
# Serves the prebuilt bundle. If you change frontend source you must rebuild:
#   cd frontend; npm run build
if (-not $NoFrontend) {
    Start-Service-Window "tscan-ui" "$root\frontend" "npx serve -s build -l 3000"
}

Write-Host ""
Write-Host "Four windows opened. The two Python services load models first:" -ForegroundColor Cyan
Write-Host "  sentiment ~2 min   rag ~30 s (embedder + model prewarm)" -ForegroundColor DarkGray
Write-Host "Run  .\start-all.ps1 -Check  until everything says up, then  .\verify.ps1" -ForegroundColor Cyan
Show-State

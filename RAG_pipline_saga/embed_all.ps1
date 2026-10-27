<#
.SYNOPSIS
    Build vector embeddings for every populated collection in the t-scan tenant.

.DESCRIPTION
    Calls the existing /api/rag/ingest endpoint - the safe, hash-incremental,
    write-then-prune path. No ad-hoc embedding, no delete_many, no bypass.

    Collections already holding STALE chunks (ingested before the retriever's
    facets existed) are re-ingested with force=$true so they pick up
    risk_level / sentiment / published_at / platform. Everything else runs
    incrementally and skips whatever is already embedded.

    Small collections run first so a facet problem surfaces in ~2 minutes
    instead of an hour into the contents run.

.EXAMPLE
    .\embed_all.ps1
    .\embed_all.ps1 -Only alerts,grievances
    .\embed_all.ps1 -WhatIf
#>
[CmdletBinding()]
param(
    [string]   $ApiBase  = "http://127.0.0.1:8100",
    [string]   $TenantId = "e4b1ec57-ceff-4f3c-a33a-7b34e1fb71d2",
    [string[]] $Only,
    [int]      $TimeoutSec = 7200,
    [switch]   $WhatIf
)

$ErrorActionPreference = "Stop"

# collection, force, note
$Jobs = @(
    @{ name = "alerts";     force = $true;  note = "244 stale chunks - force to gain facets" },
    @{ name = "grievances"; force = $true;  note = "429 stale chunks - force to gain facets" },
    @{ name = "events";     force = $false; note = "1 doc" },
    @{ name = "pois";       force = $false; note = "7 docs" },
    @{ name = "keywords";   force = $false; note = "61 docs" },
    @{ name = "sources";    force = $false; note = "469 docs" },
    @{ name = "contents";   force = $false; note = "23,077 docs / ~60K chunks - the long one" }
)

if ($Only) { $Jobs = $Jobs | Where-Object { $Only -contains $_.name } }

Write-Host ""
Write-Host "Embedding run" -ForegroundColor Cyan
Write-Host "  api    : $ApiBase"
Write-Host "  tenant : $TenantId"
Write-Host "  jobs   : $($Jobs.Count)"
Write-Host ""

# Refuse to start if the API is not up - otherwise every job fails one by one.
try {
    $h = Invoke-RestMethod -Method Get -Uri "$ApiBase/api/rag/health" -TimeoutSec 30
    if (-not $h.healthy) { throw "API reports unhealthy: $($h | ConvertTo-Json -Compress)" }
    Write-Host ("  health : OK  (embedding={0} on {1})" -f $h.embedding.status, $h.embedding.device) -ForegroundColor Green
} catch {
    Write-Host "  health : UNREACHABLE at $ApiBase" -ForegroundColor Red
    Write-Host "  Start it first:  .\run.ps1 -Port 8100 -Reload" -ForegroundColor Yellow
    exit 1
}
Write-Host ""

$started  = Get-Date
$summary  = @()

foreach ($job in $Jobs) {
    $line = "=== {0,-12} force={1,-5} {2}" -f $job.name, $job.force, $job.note
    Write-Host $line -ForegroundColor Cyan
    if ($WhatIf) { Write-Host "    (WhatIf - not run)"; continue }

    $t0   = Get-Date
    $body = @{ collection = $job.name; tenant_id = $TenantId; force = $job.force } | ConvertTo-Json

    try {
        $r    = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/rag/ingest" `
                    -ContentType "application/json" -Body $body -TimeoutSec $TimeoutSec
        $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)

        # field names vary by endpoint version; show whatever came back
        $docs   = $r.documents_processed; if ($null -eq $docs)   { $docs   = $r.processed }
        $chunks = $r.chunks_stored;       if ($null -eq $chunks) { $chunks = $r.chunks }
        $fail   = $r.embed_failures;      if ($null -eq $fail)   { $fail   = 0 }

        Write-Host ("    OK  {0}s  docs={1} chunks={2} failures={3}" -f $secs, $docs, $chunks, $fail) -ForegroundColor Green
        if ($fail -gt 0) { Write-Host "    NOTE: $fail embedding failures - check the API log" -ForegroundColor Yellow }

        $summary += [pscustomobject]@{
            Collection = $job.name; Status = "OK"; Seconds = $secs
            Docs = $docs; Chunks = $chunks; Failures = $fail
        }
    } catch {
        $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
        Write-Host ("    FAILED after {0}s : {1}" -f $secs, $_.Exception.Message) -ForegroundColor Red
        $summary += [pscustomobject]@{
            Collection = $job.name; Status = "FAILED"; Seconds = $secs
            Docs = $null; Chunks = $null; Failures = $null
        }
        # Stop rather than plough on - a failure here usually means the API died
        # or the GPU is gone, and the remaining jobs would fail identically.
        Write-Host "    Stopping. Fix the cause, then re-run - already-embedded" -ForegroundColor Yellow
        Write-Host "    chunks are skipped, so re-running is cheap and safe." -ForegroundColor Yellow
        break
    }
}

Write-Host ""
Write-Host ("Finished in {0:n1} min" -f ((Get-Date) - $started).TotalMinutes) -ForegroundColor Cyan
$summary | Format-Table -AutoSize

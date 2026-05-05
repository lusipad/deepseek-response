$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$mockOut = Join-Path $repo "exe-smoke-mock.out.log"
$mockErr = Join-Path $repo "exe-smoke-mock.err.log"
$exeOut = Join-Path $repo "exe-smoke.out.log"
$exeErr = Join-Path $repo "exe-smoke.err.log"

foreach ($path in @($mockOut, $mockErr, $exeOut, $exeErr)) {
  if (Test-Path $path) {
    Remove-Item -LiteralPath $path -Force
  }
}

if (!(Test-Path (Join-Path $repo "dist\deepseek2response.exe"))) {
  throw "dist\deepseek2response.exe not found. Run npm run build:exe first."
}

$env:MOCK_DEEPSEEK_PORT = "18588"
$env:MOCK_DEEPSEEK_SCENARIO = "text"
$mock = Start-Process -FilePath node -ArgumentList "scripts/mock-deepseek.js" -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $mockOut -RedirectStandardError $mockErr -PassThru

try {
  Start-Sleep -Milliseconds 600

  $envPath = Join-Path $repo "dist\.env"
  @"
DEEPSEEK_API_KEY=mock
DEEPSEEK_BASE_URL=http://127.0.0.1:18588
DEEPSEEK_MODEL=deepseek-auto
DEEPSEEK_ROUTER_FAST_MODEL=deepseek-v4-flash
DEEPSEEK_ROUTER_PRO_MODEL=deepseek-v4-pro
DEEPSEEK_ROUTER_DEFAULT=pro
DEEPSEEK_ROUTER_SIMPLE_NO_TOOL=fast
DEEPSEEK_ROUTER_FALLBACK=enabled
DEEPSEEK2RESPONSE_PORT=18489
DEEPSEEK2RESPONSE_HOST=127.0.0.1
DEEPSEEK2RESPONSE_API_KEY=local
"@ | Set-Content -LiteralPath $envPath -NoNewline

  $exe = Start-Process -FilePath (Join-Path $repo "dist\deepseek2response.exe") -WorkingDirectory (Join-Path $repo "dist") -WindowStyle Hidden -RedirectStandardOutput $exeOut -RedirectStandardError $exeErr -PassThru

  try {
    Start-Sleep -Milliseconds 1000
    Invoke-RestMethod "http://127.0.0.1:18489/health" | Out-Null

    $body = @{
      model = "deepseek-auto"
      input = "只回复 OK"
      stream = $false
    } | ConvertTo-Json -Compress

    $response = Invoke-RestMethod "http://127.0.0.1:18489/v1/responses" -Method Post -ContentType "application/json" -Body $body

    if ($response.status -ne "completed" -or $response.output_text -ne "OK" -or $response.model -ne "deepseek-v4-flash") {
      throw "Unexpected exe smoke response: $($response | ConvertTo-Json -Depth 8 -Compress)"
    }
  } finally {
    if ($exe -and !$exe.HasExited) {
      Stop-Process -Id $exe.Id -Force
    }
    if (Test-Path $envPath) {
      Remove-Item -LiteralPath $envPath -Force
    }
  }
} finally {
  if ($mock -and !$mock.HasExited) {
    Stop-Process -Id $mock.Id -Force
  }
}

Write-Host "exe smoke passed"

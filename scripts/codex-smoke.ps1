$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$mockOut = Join-Path $repo "mock-smoke.out.log"
$mockErr = Join-Path $repo "mock-smoke.err.log"
$proxyOut = Join-Path $repo "proxy-smoke.out.log"
$proxyErr = Join-Path $repo "proxy-smoke.err.log"

foreach ($path in @($mockOut, $mockErr, $proxyOut, $proxyErr)) {
  if (Test-Path $path) {
    Remove-Item -LiteralPath $path -Force
  }
}

$env:MOCK_DEEPSEEK_PORT = "18588"
$env:MOCK_DEEPSEEK_SCENARIO = "tool"
$mock = Start-Process -FilePath node -ArgumentList "scripts/mock-deepseek.js" -WorkingDirectory $repo -NoNewWindow -RedirectStandardOutput $mockOut -RedirectStandardError $mockErr -PassThru

try {
  Start-Sleep -Milliseconds 600
  $env:DEEPSEEK_API_KEY = "mock"
  $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:18588"
  $env:DEEPSEEK2RESPONSE_PORT = "18488"
  $proxy = Start-Process -FilePath node -ArgumentList "src/server.js" -WorkingDirectory $repo -NoNewWindow -RedirectStandardOutput $proxyOut -RedirectStandardError $proxyErr -PassThru

  try {
    Start-Sleep -Milliseconds 1000
    Invoke-RestMethod "http://127.0.0.1:18488/health" | Out-Null

    $env:DEEPSEEK2RESPONSE_API_KEY = "local"
    codex exec --ignore-user-config --skip-git-repo-check --sandbox danger-full-access -m deepseek-auto `
      -c 'model_provider="deepseek2response"' `
      -c 'model_providers.deepseek2response.name="deepseek2response"' `
      -c 'model_providers.deepseek2response.base_url="http://127.0.0.1:18488/v1"' `
      -c 'model_providers.deepseek2response.wire_api="responses"' `
      -c 'model_providers.deepseek2response.env_key="DEEPSEEK2RESPONSE_API_KEY"' `
      "Run the shell command that prints OK, then reply with exactly OK."

    if ($LASTEXITCODE -ne 0) {
      throw "codex smoke failed with exit code $LASTEXITCODE"
    }
  } finally {
    if ($proxy -and !$proxy.HasExited) {
      Stop-Process -Id $proxy.Id -Force
    }
  }
} finally {
  if ($mock -and !$mock.HasExited) {
    Stop-Process -Id $mock.Id -Force
  }
}

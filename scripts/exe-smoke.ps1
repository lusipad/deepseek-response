$ErrorActionPreference = "Stop"

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
  $listener.Start()
  try {
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Wait-ForHttp {
  param(
    [Parameter(Mandatory = $true)][string] $Url,
    [switch] $AllowNotFound
  )

  $deadline = (Get-Date).AddSeconds(20)
  $lastError = $null

  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod $Url -TimeoutSec 2 | Out-Null
      return
    } catch {
      $lastError = $_
      $statusCode = $_.Exception.Response.StatusCode.value__
      if ($AllowNotFound -and $statusCode -eq 404) {
        return
      }
      Start-Sleep -Milliseconds 300
    }
  }

  throw "Timed out waiting for $Url. Last error: $lastError"
}

$repo = Split-Path -Parent $PSScriptRoot
$mockOut = Join-Path $repo "exe-smoke-mock.out.log"
$mockErr = Join-Path $repo "exe-smoke-mock.err.log"
$exeOut = Join-Path $repo "exe-smoke.out.log"
$exeErr = Join-Path $repo "exe-smoke.err.log"
$mockPort = Get-FreeTcpPort
$proxyPort = Get-FreeTcpPort

foreach ($path in @($mockOut, $mockErr, $exeOut, $exeErr)) {
  if (Test-Path $path) {
    Remove-Item -LiteralPath $path -Force
  }
}

if (!(Test-Path (Join-Path $repo "dist\deepseek2response.exe"))) {
  throw "dist\deepseek2response.exe not found. Run npm run build:exe first."
}

$env:MOCK_DEEPSEEK_PORT = "$mockPort"
$env:MOCK_DEEPSEEK_SCENARIO = "text"
$mock = Start-Process -FilePath node -ArgumentList "scripts/mock-deepseek.js" -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $mockOut -RedirectStandardError $mockErr -PassThru

try {
  Wait-ForHttp "http://127.0.0.1:$mockPort/health" -AllowNotFound

  $envPath = Join-Path $repo "dist\.env"
  @"
DEEPSEEK_API_KEY=mock
DEEPSEEK_BASE_URL=http://127.0.0.1:$mockPort
DEEPSEEK_MODEL=deepseek-auto
DEEPSEEK_ROUTER_FAST_MODEL=deepseek-v4-flash
DEEPSEEK_ROUTER_PRO_MODEL=deepseek-v4-pro
DEEPSEEK_ROUTER_DEFAULT=pro
DEEPSEEK_ROUTER_SIMPLE_NO_TOOL=fast
DEEPSEEK_ROUTER_FALLBACK=enabled
DEEPSEEK2RESPONSE_PORT=$proxyPort
DEEPSEEK2RESPONSE_HOST=127.0.0.1
DEEPSEEK2RESPONSE_API_KEY=local
"@ | Set-Content -LiteralPath $envPath -NoNewline

  $exe = Start-Process -FilePath (Join-Path $repo "dist\deepseek2response.exe") -WorkingDirectory (Join-Path $repo "dist") -WindowStyle Hidden -RedirectStandardOutput $exeOut -RedirectStandardError $exeErr -PassThru

  try {
    Wait-ForHttp "http://127.0.0.1:$proxyPort/health"

    $body = @{
      model = "deepseek-auto"
      input = "只回复 OK"
      stream = $false
    } | ConvertTo-Json -Compress

    $response = Invoke-RestMethod "http://127.0.0.1:$proxyPort/v1/responses" -Method Post -ContentType "application/json" -Body $body

    if ($response.status -ne "completed" -or $response.output_text -ne "OK" -or $response.model -ne "deepseek-v4-flash") {
      throw "Unexpected exe smoke response: $($response | ConvertTo-Json -Depth 8 -Compress)"
    }
  } catch {
    Write-Host "mock stdout:"
    if (Test-Path $mockOut) { Get-Content -LiteralPath $mockOut -ErrorAction SilentlyContinue }
    Write-Host "mock stderr:"
    if (Test-Path $mockErr) { Get-Content -LiteralPath $mockErr -ErrorAction SilentlyContinue }
    Write-Host "exe stdout:"
    if (Test-Path $exeOut) { Get-Content -LiteralPath $exeOut -ErrorAction SilentlyContinue }
    Write-Host "exe stderr:"
    if (Test-Path $exeErr) { Get-Content -LiteralPath $exeErr -ErrorAction SilentlyContinue }
    throw
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

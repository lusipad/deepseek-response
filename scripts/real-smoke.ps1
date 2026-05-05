param(
  [string] $Fixture,
  [string] $Url = "http://127.0.0.1:18488/v1",
  [switch] $StartProxy,
  [switch] $IncludeText,
  [int] $TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

function Wait-ForHttp {
  param(
    [Parameter(Mandatory = $true)][string] $HealthUrl,
    [int] $Seconds = 30
  )

  $deadline = (Get-Date).AddSeconds($Seconds)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod $HealthUrl -TimeoutSec 2 | Out-Null
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 300
    }
  }

  throw "Timed out waiting for $HealthUrl. Last error: $lastError"
}

function Invoke-ResponsesProbe {
  param(
    [Parameter(Mandatory = $true)][string] $Name,
    [Parameter(Mandatory = $true)][object] $Body,
    [Parameter(Mandatory = $true)][string] $BaseUrl,
    [switch] $IncludeText,
    [int] $TimeoutSeconds
  )

  $bodyJson = $Body | ConvertTo-Json -Depth 30 -Compress

  if ($Body.stream) {
    $httpClient = [System.Net.Http.HttpClient]::new()
    try {
      $httpClient.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
      $httpRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$BaseUrl/responses")
      $httpRequest.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", "local-real-smoke")
      $httpRequest.Content = [System.Net.Http.StringContent]::new($bodyJson, [System.Text.Encoding]::UTF8, "application/json")
      $httpResponse = $httpClient.SendAsync($httpRequest).GetAwaiter().GetResult()
      $streamText = $httpResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if (-not $httpResponse.IsSuccessStatusCode) {
        throw "Streaming request failed with status $([int] $httpResponse.StatusCode): $streamText"
      }
    } finally {
      $httpClient.Dispose()
    }

    $summary = [ordered]@{
      name = $Name
      status = if ($streamText.Contains("response.completed")) { "completed" } else { "unknown" }
      model = if ($streamText -match '"model":"([^"]+)"') { $Matches[1] } else { $null }
      output_length = $streamText.Length
      output_has_ok = $streamText.Contains("OK")
      response_id = if ($streamText -match '"id":"(resp_[^"]+)"') { $Matches[1] } else { $null }
      stream = $true
    }

    if ($IncludeText) {
      $summary.stream_text = $streamText
    }

    $summary | ConvertTo-Json -Compress

    if ($summary.status -ne "completed") {
      throw "Probe '$Name' did not complete."
    }

    return
  }

  $response = Invoke-RestMethod "$BaseUrl/responses" `
    -Method Post `
    -ContentType "application/json" `
    -Headers @{ Authorization = "Bearer local-real-smoke" } `
    -Body $bodyJson `
    -TimeoutSec $TimeoutSeconds

  $outputText = [string] $response.output_text
  $summary = [ordered]@{
    name = $Name
    status = $response.status
    model = $response.model
    output_length = $outputText.Length
    output_has_ok = $outputText.Contains("OK")
    response_id = $response.id
    stream = $false
  }

  if ($IncludeText) {
    $summary.output_text = $outputText
  }

  $summary | ConvertTo-Json -Compress

  if ($response.status -ne "completed") {
    throw "Probe '$Name' did not complete."
  }
}

$repo = Split-Path -Parent $PSScriptRoot
$proxy = $null

if ($StartProxy) {
  $exePath = Join-Path $repo "dist\deepseek2response.exe"
  if (!(Test-Path $exePath)) {
    throw "dist\deepseek2response.exe not found. Run npm run build:exe first."
  }

  $uri = [Uri] $Url
  $env:DEEPSEEK2RESPONSE_PORT = "$($uri.Port)"
  $proxy = Start-Process -FilePath $exePath -WorkingDirectory (Join-Path $repo "dist") -WindowStyle Hidden -PassThru
}

try {
  $healthUrl = $Url -replace "/v1/?$", "/health"
  Wait-ForHttp $healthUrl

  if ($Fixture) {
    if (!(Test-Path $Fixture)) {
      throw "Fixture not found: $Fixture"
    }

    $fixtureBody = Get-Content -Raw -LiteralPath $Fixture | ConvertFrom-Json
    Invoke-ResponsesProbe -Name "fixture" -Body $fixtureBody -BaseUrl $Url -IncludeText:$IncludeText -TimeoutSeconds $TimeoutSeconds
    return
  }

  Invoke-ResponsesProbe -Name "auto-fast" -BaseUrl $Url -IncludeText:$IncludeText -TimeoutSeconds $TimeoutSeconds -Body @{
    model = "deepseek-auto"
    input = "只回复 OK"
    stream = $false
  }

  Invoke-ResponsesProbe -Name "auto-pro-reasoning" -BaseUrl $Url -IncludeText:$IncludeText -TimeoutSeconds $TimeoutSeconds -Body @{
    model = "deepseek-auto"
    input = "只回复 OK"
    stream = $false
    reasoning = @{
      effort = "high"
    }
  }

  Invoke-ResponsesProbe -Name "stream" -BaseUrl $Url -IncludeText:$IncludeText -TimeoutSeconds $TimeoutSeconds -Body @{
    model = "deepseek-auto"
    input = "只回复 OK"
    stream = $true
  }
} finally {
  if ($proxy -and !$proxy.HasExited) {
    Stop-Process -Id $proxy.Id -Force
  }
}

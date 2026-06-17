<#
.SYNOPSIS
    Проверка цепочки MAX бот: 1С HTTP-сервис → (Vercel) → MAX.

.DESCRIPTION
    База: Srvr="vmg01"; Ref="ut_srez"
    HTTP-сервис: /hs/maxwebhook/{код_бота}

    Примеры:
      .\check-max-bot.ps1 -BotKey "000000001" -OneCUser "webhook" -OneCPassword "***"
      .\check-max-bot.ps1 -BotKey "000000001" -OneCUser "webhook" -OneCPassword "***" `
          -ProxySecret "..." -VercelUrl "https://max-bot-scanner.vercel.app" `
          -BotToken "..." -MaxWebhookSecret "..."

    Скрипт лучше запускать с машины, откуда реально ходит Vercel (или с сервера IIS).
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$BotKey,

    [string]$OneCHost = "vmg01",
    [string]$OneCPublication = "ut_srez",
    [ValidateSet("http", "https")]
    [string]$OneCScheme = "http",

    [string]$OneCUser = "",
    [string]$OneCPassword = "",

    [string]$ProxySecret = "",

    [string]$VercelUrl = "",
    [string]$BotToken = "",
    [string]$MaxWebhookSecret = "",

    [switch]$SkipPost,
    [switch]$VerboseBody
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step([string]$Title) {
    Write-Host ""
    Write-Host "=== $Title ===" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "[!!] $Message" -ForegroundColor Yellow
}

function Write-Fail([string]$Message) {
    Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function New-BasicAuthHeader([string]$User, [string]$Password) {
    if ([string]::IsNullOrWhiteSpace($User)) {
        return $null
    }
    $pair = "{0}:{1}" -f $User, $Password
    $bytes = [Text.Encoding]::ASCII.GetBytes($pair)
    return "Basic " + [Convert]::ToBase64String($bytes)
}

function Invoke-CheckRequest {
    param(
        [string]$Name,
        [string]$Method,
        [string]$Uri,
        [hashtable]$Headers = @{},
        [string]$Body = $null,
        [int[]]$ExpectedStatus = @(200)
    )

    Write-Step $Name
    Write-Host "$Method $Uri"

    try {
        $params = @{
            Method      = $Method
            Uri         = $Uri
            Headers     = $Headers
            UseBasicParsing = $true
            TimeoutSec  = 30
        }
        if ($Body -ne $null) {
            $params.Body = $Body
        }

        $response = Invoke-WebRequest @params
        $status = [int]$response.StatusCode
        $content = [string]$response.Content

        if ($ExpectedStatus -contains $status) {
            Write-Ok "HTTP $status"
        }
        else {
            Write-Warn "HTTP $status (ожидалось: $($ExpectedStatus -join ', '))"
        }

        if ($VerboseBody -or $content.Length -le 500) {
            Write-Host $content
        }
        else {
            Write-Host ($content.Substring(0, [Math]::Min(500, $content.Length)) + "...")
        }

        return @{
            Ok = ($ExpectedStatus -contains $status)
            Status = $status
            Content = $content
        }
    }
    catch {
        $status = $null
        $content = $_.Exception.Message
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $content = $reader.ReadToEnd()
                $reader.Close()
            }
            catch { }
        }

        Write-Fail $(if ($status) { "HTTP $status" } else { $content })
        if ($content) {
            Write-Host $content
        }

        return @{
            Ok = $false
            Status = $status
            Content = $content
        }
    }
}

$onecBase = "{0}://{1}/{2}/hs/maxwebhook/{3}" -f $OneCScheme, $OneCHost, $OneCPublication, $BotKey
$authHeader = New-BasicAuthHeader -User $OneCUser -Password $OneCPassword

$commonHeaders = @{}
if ($authHeader) {
    $commonHeaders.Authorization = $authHeader
}

Write-Host "Проверка MAX бота"
Write-Host "1С: Srvr=$OneCHost; Ref=$OneCPublication; публикация=$OneCPublication"
Write-Host "URL 1С: $onecBase"

$results = @()

# 1) GET alive на 1С
$r = Invoke-CheckRequest -Name "1. 1С HTTP GET (alive)" -Method GET -Uri $onecBase -Headers $commonHeaders
$results += [pscustomobject]@{ Step = "1C GET alive"; Ok = $r.Ok; Detail = $r.Content }
if ($r.Ok -and $r.Content -notmatch "alive") {
    Write-Warn "Ответ не содержит 'alive' — проверьте URL и публикацию"
}

# 2) POST на 1С с секретом прокси
if (-not $SkipPost) {
    if ([string]::IsNullOrWhiteSpace($ProxySecret)) {
        Write-Step "2. 1С HTTP POST (пропуск)"
        Write-Warn "Не задан -ProxySecret. POST не выполнен."
        $results += [pscustomobject]@{ Step = "1C POST proxy"; Ok = $false; Detail = "ProxySecret not set" }
    }
    else {
        $postHeaders = $commonHeaders.Clone()
        $postHeaders["Content-Type"] = "application/json; charset=utf-8"
        $postHeaders["x-max-proxy-secret"] = $ProxySecret

        $pingBody = '{"update_type":"message_created","message":{"body":{"text":"Помощь"},"sender":{"user_id":1},"recipient":{"chat_id":1,"user_id":2}}}'

        $r = Invoke-CheckRequest -Name "2. 1С HTTP POST (секрет прокси + тест)" `
            -Method POST -Uri $onecBase -Headers $postHeaders -Body $pingBody
        $results += [pscustomobject]@{ Step = "1C POST proxy"; Ok = $r.Ok; Detail = $r.Content }

        if ($r.Status -eq 401) {
            Write-Warn "401 — секрет прокси не совпадает с полем СекретПрокси в ИСВ_MAXБоты"
        }
        if ($r.Status -eq 404) {
            Write-Warn "404 — бот с ключом $BotKey не найден в справочнике ИСВ_MAXБоты"
        }
        if ($r.Status -eq 500) {
            Write-Warn "500 — в карточке бота не заполнен СекретПрокси"
        }
    }
}

# 3) Vercel health
if (-not [string]::IsNullOrWhiteSpace($VercelUrl)) {
    $vercelHealth = ($VercelUrl.TrimEnd("/")) + "/api/max-webhook"
    $r = Invoke-CheckRequest -Name "3. Vercel GET /api/max-webhook" -Method GET -Uri $vercelHealth
    $results += [pscustomobject]@{ Step = "Vercel health"; Ok = $r.Ok; Detail = $r.Content }

    if ($r.Content -match "onec_configured.:false") {
        Write-Warn "Vercel: ONEC_WEBHOOK_URL не задан — проверьте Environment Variables"
    }
    if ($r.Content -match "onec_auth_configured.:false") {
        Write-Warn "Vercel: не заданы ONEC_WEBHOOK_USER/PASSWORD"
    }
    if ($r.Content -match "max_secret_enabled.:false") {
        Write-Warn "Vercel: MAX_WEBHOOK_SECRET не задан"
    }
    if ($r.Content -match "proxy_secret_set.:false") {
        Write-Warn "Vercel: ONEC_PROXY_SECRET не задан"
    }
}
else {
    Write-Step "3. Vercel (пропуск)"
    Write-Warn "Не задан -VercelUrl"
}

# 4) Подписки MAX
if (-not [string]::IsNullOrWhiteSpace($BotToken)) {
    Write-Step "4. MAX GET /subscriptions"
    try {
        $subs = Invoke-RestMethod -Method GET -Uri "https://platform-api.max.ru/subscriptions" `
            -Headers @{ Authorization = $BotToken }
        $json = $subs | ConvertTo-Json -Depth 10 -Compress
        Write-Ok "Подписки получены"
        Write-Host $json

        $expectedUrl = if ($VercelUrl) { ($VercelUrl.TrimEnd("/")) + "/api/max-webhook" } else { "" }
        if ($expectedUrl -and $json -notmatch [regex]::Escape($expectedUrl)) {
            Write-Warn "В подписках не найден URL: $expectedUrl"
            $results += [pscustomobject]@{ Step = "MAX subscriptions"; Ok = $false; Detail = "URL not found" }
        }
        else {
            $results += [pscustomobject]@{ Step = "MAX subscriptions"; Ok = $true; Detail = "OK" }
        }

        if ($MaxWebhookSecret -and $json -notmatch "secret") {
            Write-Warn "В ответе MAX нет поля secret — возможно подписка без секрета"
        }
    }
    catch {
        Write-Fail $_.Exception.Message
        $results += [pscustomobject]@{ Step = "MAX subscriptions"; Ok = $false; Detail = $_.Exception.Message }
    }
}
else {
    Write-Step "4. MAX (пропуск)"
    Write-Warn "Не задан -BotToken"
}

# Итог
Write-Step "Итог"
$failed = @($results | Where-Object { -not $_.Ok })
if ($failed.Count -eq 0) {
    Write-Ok "Все выполненные проверки пройдены ($($results.Count))"
}
else {
    Write-Fail "Проблемы: $($failed.Count) из $($results.Count)"
    $failed | Format-Table Step, Detail -AutoSize
}

Write-Host ""
Write-Host "Подсказки:"
Write-Host "  - Имя публикации IIS может отличаться от Ref (ut_srez). Укажите -OneCPublication."
Write-Host "  - Код бота (-BotKey) = код элемента справочника ИСВ_MAXБоты (например 000000001)."
Write-Host "  - Если с ПК не открывается, запустите скрипт на сервере IIS: -OneCHost localhost"

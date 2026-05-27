param(
    [Parameter(Mandatory = $true)][string]$BotToken,
    [Parameter(Mandatory = $true)][string]$WebhookUrl,
    [string]$Secret = ""
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{
    Authorization = $BotToken
    "Content-Type" = "application/json"
}

$payload = @{
    url = $WebhookUrl
    update_types = @("message_created", "bot_started")
}
if ($Secret) {
    $payload.secret = $Secret
}

Write-Host "DELETE /subscriptions (url=$WebhookUrl)"
$deleteUri = "https://platform-api.max.ru/subscriptions?url=" + [uri]::EscapeDataString($WebhookUrl)
try {
    Invoke-RestMethod -Method DELETE -Uri $deleteUri -Headers @{ Authorization = $BotToken } | Out-Null
}
catch {
    Write-Host "DELETE skipped or failed:" $_.Exception.Message
}

Write-Host "POST /subscriptions"
$body = ($payload | ConvertTo-Json -Depth 5 -Compress)
Invoke-RestMethod -Method POST -Uri "https://platform-api.max.ru/subscriptions" -Headers $headers -Body $body | ConvertTo-Json -Depth 10

Write-Host "GET /subscriptions"
Invoke-RestMethod -Method GET -Uri "https://platform-api.max.ru/subscriptions" -Headers @{ Authorization = $BotToken } | ConvertTo-Json -Depth 10

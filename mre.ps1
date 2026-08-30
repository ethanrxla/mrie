[CmdletBinding()]
param(
    [ValidateSet("setup", "start", "status", "news", "briefing")]
    [string]$Command = "start"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$WebRoot = Join-Path $ProjectRoot "apps\web"
$VenvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$WebServer = Join-Path $WebRoot ".next\standalone\apps\web\server.js"
$DashboardUrl = "http://localhost:3001"
$MrePort = 17351
$DashboardPort = 3001

function Get-NpmCommand {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$npm) {
        throw "npm.cmd was not found. Install a supported Node.js LTS release, then reopen PowerShell."
    }
    return $npm.Source
}

function Get-NodeVersion {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$node) {
        throw "Node.js was not found. Install Node 20.19+, 22.13+, or 24+, then reopen PowerShell."
    }
    $raw = (& $node.Source --version).TrimStart("v")
    try {
        return [version]$raw
    }
    catch {
        throw "Could not parse the installed Node.js version '$raw'."
    }
}

function Assert-SupportedNode {
    $version = Get-NodeVersion
    $supported =
        (($version.Major -eq 20) -and ($version -ge [version]"20.19.0")) -or
        (($version.Major -eq 22) -and ($version -ge [version]"22.13.0")) -or
        ($version.Major -ge 24)
    if (!$supported) {
        throw "Node $version is installed, but MRE requires Node 20.19+, 22.13+, or 24+. Install the current Node LTS from https://nodejs.org/ and rerun '.\mre.ps1 setup'."
    }
}

function Write-NodeWarning {
    $version = Get-NodeVersion
    $supported =
        (($version.Major -eq 20) -and ($version -ge [version]"20.19.0")) -or
        (($version.Major -eq 22) -and ($version -ge [version]"22.13.0")) -or
        ($version.Major -ge 24)
    if (!$supported) {
        Write-Warning "Node $version is below MRE's supported floor. The existing build may start, but install a current Node LTS from https://nodejs.org/ before the next setup/build."
    }
}

function New-MreVenv {
    if (Test-Path -LiteralPath $VenvPython) {
        return
    }
    $py = Get-Command py.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$py) {
        throw "Python 3.12 was not found. Install Python 3.12, then rerun '.\mre.ps1 setup'."
    }
    Write-Host "Creating the MRE Python environment..." -ForegroundColor Cyan
    & $py.Source -3.12 -m venv (Join-Path $ProjectRoot ".venv")
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $VenvPython)) {
        throw "Python could not create .venv with Python 3.12."
    }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)] [string]$Executable,
        [Parameter(ValueFromRemainingArguments)] [string[]]$Arguments
    )
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "'$Executable $($Arguments -join ' ')' failed with exit code $LASTEXITCODE."
    }
}

function Test-TcpPort {
    param([int]$Port)
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        return $task.Wait(500) -and $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Invoke-MreRpc {
    param(
        [Parameter(Mandatory)] [string]$Method,
        [object]$Parameters = @{},
        [int]$ReadTimeoutMilliseconds = 10000
    )
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.ConnectAsync("127.0.0.1", $MrePort)
        if (!$connect.Wait(2000) -or !$client.Connected) {
            throw "MRE backend did not accept a connection on port $MrePort."
        }
        $stream = $client.GetStream()
        $stream.ReadTimeout = $ReadTimeoutMilliseconds
        $stream.WriteTimeout = 5000
        $writer = [System.IO.StreamWriter]::new(
            $stream,
            [System.Text.UTF8Encoding]::new($false),
            1024,
            $true
        )
        $writer.AutoFlush = $true
        $request = [ordered]@{
            jsonrpc = "2.0"
            id = 1
            method = $Method
            params = $Parameters
        } | ConvertTo-Json -Compress -Depth 10
        $writer.WriteLine($request)
        $reader = [System.IO.StreamReader]::new(
            $stream,
            [System.Text.Encoding]::UTF8,
            $false,
            1024,
            $true
        )
        $line = $reader.ReadLine()
        if (!$line) {
            throw "MRE backend closed the connection before replying to '$Method'."
        }
        $response = $line | ConvertFrom-Json
        if ($response.error) {
            throw "MRE backend rejected '$Method': $($response.error.message)"
        }
        return $response.result
    }
    finally {
        $client.Dispose()
    }
}

function Get-MreRpcStatus {
    try {
        $result = Invoke-MreRpc -Method "status" -ReadTimeoutMilliseconds 2000
        if ($result.agent -ne "MRE") { return $null }
        return $result
    }
    catch {
        return $null
    }
}

function Assert-MreBackend {
    $rpc = Get-MreRpcStatus
    if ($rpc) { return $rpc }
    if (Test-TcpPort $MrePort) {
        throw "Port $MrePort is occupied by process $(Get-PortOwner $MrePort), but it is not a healthy MRE backend."
    }
    throw "MRE backend is stopped. Start it in another PowerShell window with '.\mre.ps1'."
}

function Get-DashboardStatus {
    try {
        return Invoke-RestMethod "$DashboardUrl/api/status" -TimeoutSec 3
    }
    catch {
        return $null
    }
}

function Get-PortOwner {
    param([int]$Port)
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (!$connection) { return $null }
    $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
    return "$($connection.OwningProcess) ($($process.ProcessName))"
}

function Test-WebBuildStale {
    if (!(Test-Path -LiteralPath $WebServer)) {
        return $true
    }
    $builtAt = (Get-Item -LiteralPath $WebServer).LastWriteTimeUtc
    $roots = @(
        (Join-Path $WebRoot "src"),
        (Join-Path $WebRoot "public"),
        (Join-Path $WebRoot "scripts")
    )
    $files = @(
        (Join-Path $WebRoot "package.json"),
        (Join-Path $WebRoot "package-lock.json"),
        (Join-Path $WebRoot "next.config.ts"),
        (Join-Path $WebRoot "tsconfig.json"),
        (Join-Path $WebRoot "postcss.config.mjs")
    )
    foreach ($root in $roots) {
        if (Test-Path -LiteralPath $root) {
            $newer = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTimeUtc -gt $builtAt } |
                Select-Object -First 1
            if ($newer) { return $true }
        }
    }
    foreach ($file in $files) {
        if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).LastWriteTimeUtc -gt $builtAt) {
            return $true
        }
    }
    return $false
}

function Invoke-Setup {
    Write-NodeWarning
    $npm = Get-NpmCommand
    New-MreVenv

    Write-Host "Installing the MRE backend..." -ForegroundColor Cyan
    Invoke-Native -Executable $VenvPython -Arguments @("-m", "pip", "install", "--upgrade", "pip")
    Invoke-Native -Executable $VenvPython -Arguments @("-m", "pip", "install", "-e", ".[dev]")

    if (!(Test-Path -LiteralPath (Join-Path $ProjectRoot ".env"))) {
        Copy-Item -LiteralPath (Join-Path $ProjectRoot ".env.example") -Destination (Join-Path $ProjectRoot ".env")
    }
    if (!(Test-Path -LiteralPath (Join-Path $ProjectRoot "config\mrie.yaml"))) {
        Copy-Item -LiteralPath (Join-Path $ProjectRoot "config\mrie.example.yaml") -Destination (Join-Path $ProjectRoot "config\mrie.yaml")
    }

    Write-Host "Installing and building the dashboard..." -ForegroundColor Cyan
    Push-Location $WebRoot
    try {
        Invoke-Native -Executable $npm -Arguments @("ci")
        Invoke-Native -Executable $npm -Arguments @("run", "build")
    }
    finally {
        Pop-Location
    }

    Write-Host "MRE setup is complete. Start it with: .\mre.ps1 start" -ForegroundColor Green
}

function Invoke-Start {
    [void](Get-NodeVersion)
    if (!(Test-Path -LiteralPath (Join-Path $WebRoot "node_modules"))) {
        throw "Dashboard dependencies are missing. Run '.\mre.ps1 setup' once."
    }

    $python = $VenvPython
    if (!(Test-Path -LiteralPath $python)) {
        $py = Get-Command py.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if (!$py) {
            throw "Python 3.12 was not found. Run '.\mre.ps1 setup' after installing Python 3.12."
        }
        $python = (& $py.Source -3.12 -c "import sys; print(sys.executable)").Trim()
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $python)) {
            throw "Python 3.12 could not be resolved. Run '.\mre.ps1 setup'."
        }
        & $python -c "import croniter, dotenv, feedparser, httpx, openai, yaml" 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "MRE's Python dependencies are missing. Run '.\mre.ps1 setup' once."
        }
        Write-Warning "Using system Python 3.12. Run '.\mre.ps1 setup' later to create the isolated environment."
    }

    $dashboard = Get-DashboardStatus
    if ($dashboard) {
        Write-Host "MRE is already running at $DashboardUrl" -ForegroundColor Green
        Start-Process $DashboardUrl
        return
    }
    if (Test-TcpPort $DashboardPort) {
        throw "Port $DashboardPort is occupied by process $(Get-PortOwner $DashboardPort), but it is not a healthy MRE dashboard."
    }

    if (Test-TcpPort $MrePort) {
        $rpc = Get-MreRpcStatus
        if (!$rpc) {
            throw "Port $MrePort is occupied by process $(Get-PortOwner $MrePort), but it is not an MRE backend."
        }
        Write-Host "Using the MRE backend already listening on port $MrePort." -ForegroundColor DarkGray
    }

    if (Test-WebBuildStale) {
        throw "The dashboard build is missing or stale. Run '.\mre.ps1 setup' once, then start MRE again."
    }

    $env:MRIE_PYTHON = $python
    Write-Host "Starting the MRE backend and dashboard..." -ForegroundColor Cyan
    Write-Host "Open $DashboardUrl (Ctrl+C stops services started by this command)." -ForegroundColor Green
    Push-Location $WebRoot
    try {
        & node .\scripts\start-standalone.mjs --local --port 3001 --host 127.0.0.1
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($exitCode -ne 0) {
        throw "MRE stopped with exit code $exitCode."
    }
}

function Invoke-Status {
    $rpc = Get-MreRpcStatus
    $dashboard = Get-DashboardStatus
    [pscustomobject]@{
        Backend = if ($rpc) { "running" } elseif (Test-TcpPort $MrePort) { "wrong service on port $MrePort" } else { "stopped" }
        Dashboard = if ($dashboard) { "running" } elseif (Test-TcpPort $DashboardPort) { "wrong service on port $DashboardPort" } else { "stopped" }
        Url = if ($dashboard) { $DashboardUrl } else { $null }
        Llm = $dashboard.services.llm
        SpeechToText = $dashboard.services.speechToText
        TextToSpeech = $dashboard.services.textToSpeech
        Scheduler = if ($rpc) { $rpc.scheduler.running } else { $false }
        EventWatcher = if ($rpc) { $rpc.event_watcher.running } else { $false }
    } | Format-List
}

function Invoke-NewsTest {
    [void](Assert-MreBackend)
    Write-Host "Testing live news sources (no model or voice)..." -ForegroundColor Cyan
    $result = Invoke-MreRpc -Method "news.test" -Parameters @{ limit = 10 } -ReadTimeoutMilliseconds 120000

    $rss = $result.sources.rss
    $rssColor = if ($rss.success) { "Green" } else { "Red" }
    Write-Host "RSS: $($rss.headline_count) current headlines" -ForegroundColor $rssColor
    foreach ($feed in @($rss.feeds)) {
        $state = if ($feed.success) { "OK" } else { "FAILED" }
        $color = if ($feed.success) { "Green" } else { "Red" }
        Write-Host ("  [{0}] {1} ({2} headlines)" -f $state, $feed.source, $feed.headline_count) -ForegroundColor $color
    }
    if ($rss.error) {
        Write-Host "  $($rss.error)" -ForegroundColor Red
    }

    $newsapi = $result.sources.newsapi
    if ($newsapi.success) {
        Write-Host "NewsAPI: OK ($($newsapi.article_count) results)" -ForegroundColor Green
    }
    elseif (!$newsapi.configured) {
        Write-Host "NewsAPI: not configured (RSS reporting still works)" -ForegroundColor Yellow
    }
    else {
        Write-Host "NewsAPI: FAILED - $($newsapi.error)" -ForegroundColor Red
    }

    $reddit = $result.sources.reddit
    if ($reddit.success) {
        Write-Host "Reddit: OK ($($reddit.post_count) posts from $($reddit.feed))" -ForegroundColor Green
    }
    elseif (!$reddit.configured) {
        Write-Host "Reddit: not configured (approved OAuth credentials required)" -ForegroundColor Yellow
    }
    else {
        Write-Host "Reddit: FAILED - $($reddit.error)" -ForegroundColor Red
    }

    if (@($rss.headlines).Count -gt 0) {
        Write-Host "`nLatest RSS headlines:" -ForegroundColor Cyan
        $number = 1
        foreach ($headline in @($rss.headlines)) {
            Write-Host ("  {0}. {1}" -f $number, $headline.title)
            Write-Host ("     {0}" -f $headline.link) -ForegroundColor DarkGray
            $number += 1
        }
    }

    if (@($reddit.posts).Count -gt 0) {
        Write-Host "`nLatest Reddit posts:" -ForegroundColor Cyan
        $number = 1
        foreach ($post in @($reddit.posts)) {
            Write-Host ("  {0}. {1}" -f $number, $post.title)
            Write-Host ("     {0}" -f $post.url) -ForegroundColor DarkGray
            $number += 1
        }
    }
}

function Invoke-LiveBriefing {
    [void](Assert-MreBackend)
    Write-Host "Collecting, generating, archiving, and queuing a live MRE briefing..." -ForegroundColor Cyan
    $result = Invoke-MreRpc -Method "briefings.run" -Parameters @{ dry_run = $false } -ReadTimeoutMilliseconds 600000
    if ($result.busy) {
        $phase = $result.scheduler.active_run.phase
        throw "A briefing is already running (phase: $phase). Wait for it to finish, then try again."
    }
    if (!$result.briefing) {
        throw "MRE completed the request but did not return an archived briefing."
    }

    $briefing = $result.briefing
    Write-Host "`n$($briefing.summary)"
    Write-Host "`nArchived: $($briefing.id)" -ForegroundColor Green
    $delivery = $briefing.delivery.status
    if ($delivery -in @("queued", "pending")) {
        Write-Host "Voice delivery: queued; the running MRE delivery worker will speak it." -ForegroundColor Green
    }
    elseif ($delivery -eq "played") {
        Write-Host "Voice delivery: played" -ForegroundColor Green
    }
    else {
        Write-Host "Voice delivery: $delivery ($($briefing.delivery.reason))" -ForegroundColor Yellow
    }
}

Set-Location $ProjectRoot
switch ($Command) {
    "setup" { Invoke-Setup }
    "start" { Invoke-Start }
    "status" { Invoke-Status }
    "news" { Invoke-NewsTest }
    "briefing" { Invoke-LiveBriefing }
}

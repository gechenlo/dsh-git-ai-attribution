$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
$owner = 'gechenlo'; $name = 'dsh-git-ai-attribution'
$api = "https://api.github.com/repos/$owner/$name"
$candObj = Join-Path $env:TEMP 'git-ai-push-cand.obj'
$rawCommit = Join-Path $env:TEMP 'git-ai-push-rawcommit.bin'

Push-Location $repoDir
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
$tok = ($cred | Select-String '^password=').Line -replace '^password=', ''
$h = @{ Authorization = "Bearer $tok"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'dsh-push' }

function Invoke-GH($method, $uri, $body) {
  $p = @{ Method = $method; Uri = $uri; Headers = $h; TimeoutSec = 60; ContentType = 'application/json; charset=utf-8' }
  if ($body) { $p['Body'] = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 10 -Compress)) }
  return Invoke-RestMethod @p
}

$local = (git rev-parse HEAD).Trim()
$remote = (Invoke-GH GET "$api/git/ref/heads/master").object.sha
"local=$local remote=$remote"
if ($remote -eq $local) { 'already in sync'; Pop-Location; exit 0 }

$parent = (git rev-parse "$local~1").Trim()
if ($remote -ne $parent) { "ABORT: remote master $remote is not local parent $parent"; Pop-Location; exit 1 }

$baseTree = (Invoke-GH GET "$api/git/commits/$remote").tree.sha
"base_tree=$baseTree"

$changed = git diff --name-status $remote $local
$entries = @()
foreach ($line in $changed) {
  $parts = $line -split "`t"
  $st = $parts[0]; $path = $parts[1]
  if ($st -eq 'D') {
    $entries += @{ path = $path; mode = '100644'; type = 'blob'; sha = $null }
    continue
  }
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $repoDir $path))
  $blob = Invoke-GH POST "$api/git/blobs" @{ content = [Convert]::ToBase64String($bytes); encoding = 'base64' }
  $entries += @{ path = $path; mode = '100644'; type = 'blob'; sha = $blob.sha }
  "blob $path -> $($blob.sha)"
}

$tree = Invoke-GH POST "$api/git/trees" @{ base_tree = $baseTree; tree = $entries }
"tree=$($tree.sha)"

# Exact local commit bytes, read via cmd redirection to stay binary-safe.
cmd /c "git cat-file commit $local > $rawCommit"
$rawBytes = [System.IO.File]::ReadAllBytes("$rawCommit")
$nl = [byte]10
$sep = -1
for ($i = 0; $i -lt $rawBytes.Length - 1; $i++) {
  if ($rawBytes[$i] -eq $nl -and $rawBytes[$i + 1] -eq $nl) { $sep = $i; break }
}
if ($sep -lt 0) { throw 'commit object has no header separator' }
$header = [System.Text.Encoding]::UTF8.GetString($rawBytes, 0, $sep)
$bodyBytes = New-Object byte[] ($rawBytes.Length - $sep - 2)
[Array]::Copy($rawBytes, $sep + 2, $bodyBytes, 0, $bodyBytes.Length)
$body = [System.Text.Encoding]::UTF8.GetString($bodyBytes)
$lines = $header -split "`n"
$authorLine = ($lines | Where-Object { $_ -like 'author *' }) -replace '^author ', ''
$committerLine = ($lines | Where-Object { $_ -like 'committer *' }) -replace '^committer ', ''

# Git stores "epoch +hhmm"; the API only accepts ISO 8601 with the same offset.
$epochA = [long]($authorLine -replace '.*> (\d+) .*', '$1')
$offA = $authorLine -replace '.*\d+ ', ''
$epochC = [long]($committerLine -replace '.*> (\d+) .*', '$1')
$offC = $committerLine -replace '.*\d+ ', ''
function Convert-GitDate([long]$epoch, [string]$off) {
  $sign = if ($off.StartsWith('-')) { -1 } else { 1 }
  $span = New-TimeSpan -Hours ($sign * [int]$off.Substring(1, 2)) -Minutes ($sign * [int]$off.Substring(3, 2))
  return [DateTimeOffset]::FromUnixTimeSeconds($epoch).ToOffset($span).ToString('yyyy-MM-ddTHH:mm:sszzz')
}

$commitBody = @{
  message   = $body
  tree      = $tree.sha
  parents   = @($parent)
  author    = @{ name = ($authorLine -split ' <')[0]; email = ($authorLine -replace '.*<([^>]+)>.*', '$1'); date = (Convert-GitDate $epochA $offA) }
  committer = @{ name = ($committerLine -split ' <')[0]; email = ($committerLine -replace '.*<([^>]+)>.*', '$1'); date = (Convert-GitDate $epochC $offC) }
}
$newCommit = Invoke-GH POST "$api/git/commits" $commitBody
"new_commit=$($newCommit.sha)"

Invoke-GH PATCH "$api/git/refs/heads/master" @{ sha = $newCommit.sha; force = $false } | Out-Null
"ref_master updated"

# Rebuild the object locally so local and remote agree byte for byte.
$treeLine = ($lines | Where-Object { $_ -like 'tree *' })
$parentLine = ($lines | Where-Object { $_ -like 'parent *' })
$variants = @($body, $body.TrimEnd("`n")) | Select-Object -Unique
foreach ($msg in $variants) {
  $txt = "$treeLine`n$parentLine`nauthor $authorLine`ncommitter $committerLine`n`n" + $msg
  [System.IO.File]::WriteAllBytes("$candObj", [System.Text.Encoding]::UTF8.GetBytes($txt))
  $sha = (cmd /c "git hash-object -t commit --stdin < $candObj").Trim()
  "candidate len=$($msg.Length) sha=$sha match=$($sha -eq $newCommit.sha)"
  if ($sha -eq $newCommit.sha) {
    cmd /c "git hash-object -t commit -w --stdin < $candObj" | Out-Null
    git update-ref refs/heads/master $newCommit.sha
    git update-ref refs/remotes/origin/master $newCommit.sha
    'local refs synced to remote sha'
    break
  }
}
Pop-Location

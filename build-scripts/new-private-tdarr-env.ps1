[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Target
)

$ErrorActionPreference = 'Stop'
$resolvedParent = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Target))
)
$resolvedTarget = [System.IO.Path]::Combine(
    $resolvedParent,
    [System.IO.Path]::GetFileName($Target)
)
if ([System.IO.Path]::GetFileName($resolvedTarget) -ne '.env') {
    throw "Refusing to create a private Tdarr environment file not named .env: $resolvedTarget"
}
if (-not [System.IO.Directory]::Exists($resolvedParent)) {
    throw "Target directory does not exist: $resolvedParent"
}
if ([System.IO.File]::Exists($resolvedTarget)) {
    throw "Refusing to overwrite existing private environment file: $resolvedTarget"
}

$bytes = New-Object byte[] 32
$volumeBytes = New-Object byte[] 16
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
    $rng.GetBytes($volumeBytes)
} finally {
    $rng.Dispose()
}
$apiHex = -join @($bytes | ForEach-Object { $_.ToString('x2') })
$volumeHex = -join @($volumeBytes | ForEach-Object { $_.ToString('x2') })
$apiKey = 'tapi_' + $apiHex
$privateRuntimeVolume = 'tdarr-private-runtime-' + $volumeHex
$content = @(
    '# Generated locally. Never commit or paste this file into reports.'
    "TDARR_API_KEY=$apiKey"
    'TDARR_FLOW_PARITY_BOOTSTRAP=0'
    "TDARR_PRIVATE_RUNTIME_VOLUME=$privateRuntimeVolume"
    ''
) -join [Environment]::NewLine

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($resolvedTarget, $content, $utf8NoBom)

$created = Get-Item -LiteralPath $resolvedTarget
if ($created.Length -lt 80) {
    throw 'Generated private environment file is unexpectedly short'
}
Write-Output (
    "Created {0} with a {1}-character tapi_ key and a unique private-volume name; values not displayed." -f
    $resolvedTarget, $apiKey.Length
)

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Configure', 'Start', 'Status')]
    [string]$Action,

    [Parameter()]
    [string]$ClientJsonPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ExpectedRedirectUri = 'http://127.0.0.1:8788/v1/integrations/gmail/callback'
$script:CredentialFieldNames = @(
    'EMAR_GOOGLE_CLIENT_ID',
    'EMAR_GOOGLE_CLIENT_SECRET',
    'EMAR_TOKEN_ENCRYPTION_KEY'
)

function Assert-WindowsPlatform {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This helper requires Windows DPAPI and will not use plaintext storage.'
    }
}

function Get-VaultPath {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'The current user Local AppData directory is unavailable.'
    }

    return [IO.Path]::Combine($env:LOCALAPPDATA, 'Emar', 'credentials.dpapi')
}

function Get-ProtectedDataType {
    $typeName = 'System.Security.Cryptography.ProtectedData'
    $assembly = [AppDomain]::CurrentDomain.GetAssemblies() |
        Where-Object { $null -ne $_.GetType($typeName, $false) } |
        Select-Object -First 1

    if ($null -eq $assembly) {
        foreach ($assemblyName in @('System.Security.Cryptography.ProtectedData', 'System.Security')) {
            try {
                $assembly = [Reflection.Assembly]::Load($assemblyName)
                if ($null -ne $assembly.GetType($typeName, $false)) {
                    break
                }
                $assembly = $null
            }
            catch {
                $assembly = $null
            }
        }
    }

    if ($null -eq $assembly) {
        throw 'Windows DPAPI is unavailable; credentials were not read or written.'
    }

    return $assembly.GetType($typeName, $true)
}

function Invoke-UserDpapi {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('Protect', 'Unprotect')]
        [string]$Operation,

        [Parameter(Mandatory = $true)]
        [byte[]]$Bytes
    )

    try {
        $dpapiType = Get-ProtectedDataType
        $method = $dpapiType.GetMethods([Reflection.BindingFlags]'Public, Static') |
            Where-Object {
                $_.Name -eq $Operation -and
                $_.GetParameters().Count -eq 3 -and
                $_.GetParameters()[0].ParameterType -eq [byte[]]
            } |
            Select-Object -First 1

        if ($null -eq $method) {
            throw 'Windows DPAPI method not found.'
        }

        $scopeType = $dpapiType.Assembly.GetType('System.Security.Cryptography.DataProtectionScope', $true)
        $currentUserScope = [Enum]::Parse($scopeType, 'CurrentUser')
        $result = $method.Invoke($null, [object[]]@($Bytes, $null, $currentUserScope))
        return ,([byte[]]$result)
    }
    catch {
        throw 'Credential vault could not be protected or opened with Windows DPAPI.'
    }
}

function Read-CredentialVault {
    $vaultPath = Get-VaultPath
    if (-not [IO.File]::Exists($vaultPath)) {
        return $null
    }

    try {
        $encoded = [IO.File]::ReadAllText($vaultPath, [Text.Encoding]::ASCII)
        $protectedBytes = [Convert]::FromBase64String($encoded)
        $plainBytes = Invoke-UserDpapi -Operation Unprotect -Bytes $protectedBytes
        $json = [Text.Encoding]::UTF8.GetString($plainBytes)
        $stored = ConvertFrom-Json -InputObject $json -ErrorAction Stop

        $clientId = [string]$stored.clientId
        $clientSecret = [string]$stored.clientSecret
        $encryptionKey = [string]$stored.encryptionKey

        if ([string]::IsNullOrWhiteSpace($clientId) -or
            [string]::IsNullOrWhiteSpace($clientSecret) -or
            $encryptionKey -notmatch '^[0-9a-fA-F]{64}$') {
            throw 'Invalid vault fields.'
        }

        return [pscustomobject]@{
            ClientId = $clientId
            ClientSecret = $clientSecret
            EncryptionKey = $encryptionKey
        }
    }
    catch {
        throw 'Credential vault is unreadable or invalid. No plaintext fallback was attempted.'
    }
}

function Write-CredentialVault {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ClientId,

        [Parameter(Mandatory = $true)]
        [string]$ClientSecret,

        [Parameter(Mandatory = $true)]
        [string]$EncryptionKey
    )

    if ($EncryptionKey -notmatch '^[0-9a-fA-F]{64}$') {
        throw 'The existing encryption key is invalid; it was not rotated.'
    }

    $vaultPath = Get-VaultPath
    $directory = [IO.Path]::GetDirectoryName($vaultPath)
    $temporaryPath = [IO.Path]::Combine($directory, ('.credentials-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
    $json = ConvertTo-Json -InputObject ([ordered]@{
        clientId = $ClientId
        clientSecret = $ClientSecret
        encryptionKey = $EncryptionKey
    }) -Compress
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($json)
    $protectedBytes = Invoke-UserDpapi -Operation Protect -Bytes $plainBytes
    $encoded = [Convert]::ToBase64String($protectedBytes)

    try {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        [IO.File]::WriteAllText($temporaryPath, $encoded, [Text.Encoding]::ASCII)

        if ([IO.File]::Exists($vaultPath)) {
            [IO.File]::Replace($temporaryPath, $vaultPath, $null)
        }
        else {
            [IO.File]::Move($temporaryPath, $vaultPath)
        }
    }
    catch {
        throw 'Credential vault could not be saved atomically.'
    }
    finally {
        if ([IO.File]::Exists($temporaryPath)) {
            try { [IO.File]::Delete($temporaryPath) } catch { }
        }
    }
}

function Convert-SecureStringToPlainText {
    param([Parameter(Mandatory = $true)][Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function New-EncryptionKey {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
        return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    }
    finally {
        $generator.Dispose()
    }
}

function Read-NewClientCredentials {
    if (-not [string]::IsNullOrWhiteSpace($ClientJsonPath)) {
        try {
            $jsonText = [IO.File]::ReadAllText($ClientJsonPath)
            $document = ConvertFrom-Json -InputObject $jsonText -ErrorAction Stop
            $webClient = $document.PSObject.Properties['web'].Value
            $clientId = [string]$webClient.client_id
            $clientSecret = [string]$webClient.client_secret
        }
        catch {
            throw 'OAuth client JSON could not be read. Supply a Google web-client JSON file.'
        }
    }
    else {
        $clientId = Read-Host 'Google OAuth client ID'
        $secureSecret = Read-Host 'Google OAuth client secret' -AsSecureString
        $clientSecret = Convert-SecureStringToPlainText -Value $secureSecret
    }

    if ([string]::IsNullOrWhiteSpace($clientId) -or
        [string]::IsNullOrWhiteSpace($clientSecret) -or
        $clientId -match '[\r\n]' -or
        $clientSecret -match '[\r\n]') {
        throw 'OAuth client ID or secret is missing or invalid.'
    }

    return [pscustomobject]@{
        ClientId = $clientId
        ClientSecret = $clientSecret
    }
}

function Assert-FixedRedirectUri {
    $parsedUri = $null
    $isValid = [Uri]::TryCreate($script:ExpectedRedirectUri, [UriKind]::Absolute, [ref]$parsedUri)
    if (-not $isValid -or
        $parsedUri.Scheme -ne 'http' -or
        $parsedUri.Host -ne '127.0.0.1' -or
        $parsedUri.Port -ne 8788 -or
        $parsedUri.AbsolutePath -ne '/v1/integrations/gmail/callback' -or
        -not [string]::IsNullOrEmpty($parsedUri.Query) -or
        -not [string]::IsNullOrEmpty($parsedUri.Fragment)) {
        throw 'The configured callback URI is not the fixed local Emar callback.'
    }
}

function Invoke-Configure {
    Assert-WindowsPlatform
    Assert-FixedRedirectUri

    # Read the old vault before accepting replacements so a damaged vault cannot
    # accidentally generate a new key and strand tokens encrypted by the old one.
    $existing = Read-CredentialVault
    $newClient = Read-NewClientCredentials
    $encryptionKey = if ($null -ne $existing) { $existing.EncryptionKey } else { New-EncryptionKey }

    Write-CredentialVault -ClientId $newClient.ClientId -ClientSecret $newClient.ClientSecret -EncryptionKey $encryptionKey
    Write-Output 'Local OAuth credentials are stored with current-user Windows DPAPI protection.'
    Write-Output ('In Google Cloud, register this authorized redirect URI: ' + $script:ExpectedRedirectUri)
    Write-Output 'Live Google sign-in has not been verified.'
}

function Invoke-Status {
    Assert-WindowsPlatform
    Assert-FixedRedirectUri

    $credentials = Read-CredentialVault
    Write-Output 'Configured: EMAR_GOOGLE_REDIRECT_URI'
    if ($null -eq $credentials) {
        Write-Output ('Missing: ' + ($script:CredentialFieldNames -join ', '))
    }
    else {
        Write-Output ('Configured: ' + ($script:CredentialFieldNames -join ', '))
    }
}

function Invoke-Start {
    Assert-WindowsPlatform
    Assert-FixedRedirectUri

    $credentials = Read-CredentialVault
    if ($null -eq $credentials) {
        throw 'OAuth credentials are not configured. Run this helper with -Action Configure first.'
    }

    $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $nodeScript = Join-Path $repoRoot 'src/index.mjs'
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $nodeExecutable = [string]$nodeCommand.Source
    if ([string]::IsNullOrWhiteSpace($nodeExecutable)) {
        throw 'A Node.js executable could not be selected.'
    }

    $nodeVersionOutput = @(& $nodeExecutable --version 2>$null)
    if ($LASTEXITCODE -ne 0 -or @($nodeVersionOutput).Count -ne 1) {
        throw 'Node.js version could not be verified; Emar requires Node.js 22.13.0 or newer.'
    }

    $nodeVersionText = [string]$nodeVersionOutput[0]
    if ($nodeVersionText -notmatch '^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:[-+].*)?$') {
        throw 'Node.js version could not be verified; Emar requires Node.js 22.13.0 or newer.'
    }

    $nodeVersion = [Version]::Parse(('{0}.{1}.{2}' -f $Matches.major, $Matches.minor, $Matches.patch))
    if ($nodeVersion -lt [Version]'22.13.0') {
        throw 'Node.js 22.13.0 or newer is required to start Emar.'
    }

    $environmentNames = @(
        'EMAR_GOOGLE_CLIENT_ID',
        'EMAR_GOOGLE_CLIENT_SECRET',
        'EMAR_GOOGLE_REDIRECT_URI',
        'EMAR_TOKEN_ENCRYPTION_KEY'
    )
    $previousEnvironment = @{}

    foreach ($name in $environmentNames) {
        $present = $null -ne (Get-Item -LiteralPath (Join-Path 'Env:' $name) -ErrorAction SilentlyContinue)
        $previousEnvironment[$name] = [pscustomobject]@{
            Present = $present
            Value = [Environment]::GetEnvironmentVariable($name, 'Process')
        }
    }

    $exitCode = 1
    try {
        [Environment]::SetEnvironmentVariable('EMAR_GOOGLE_CLIENT_ID', $credentials.ClientId, 'Process')
        [Environment]::SetEnvironmentVariable('EMAR_GOOGLE_CLIENT_SECRET', $credentials.ClientSecret, 'Process')
        [Environment]::SetEnvironmentVariable('EMAR_GOOGLE_REDIRECT_URI', $script:ExpectedRedirectUri, 'Process')
        [Environment]::SetEnvironmentVariable('EMAR_TOKEN_ENCRYPTION_KEY', $credentials.EncryptionKey, 'Process')

        Push-Location -LiteralPath $repoRoot
        try {
            & $nodeExecutable $nodeScript
            $exitCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }
    }
    finally {
        foreach ($name in $environmentNames) {
            $prior = $previousEnvironment[$name]
            if ($prior.Present) {
                [Environment]::SetEnvironmentVariable($name, $prior.Value, 'Process')
            }
            else {
                [Environment]::SetEnvironmentVariable($name, $null, 'Process')
            }
        }
    }

    if ($exitCode -ne 0) {
        throw 'Emar exited with a nonzero status.'
    }

    Write-Output 'Emar exited normally.'
}

try {
    switch ($Action) {
        'Configure' { Invoke-Configure }
        'Start' { Invoke-Start }
        'Status' { Invoke-Status }
    }
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}

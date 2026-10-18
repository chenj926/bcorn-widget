# Requires Windows PowerShell 5.1 or newer. Passwords go only to native tools.
[CmdletBinding()]
param([string]$MetadataPath = (Join-Path $PSScriptRoot 'release-metadata.json'),
      [string]$BuildToolsPath, [switch]$ValidateOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$stage = $null
function Fail([string]$Message) { throw $Message }
function Run([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "Tool failed ($LASTEXITCODE): $Exe" }
}
function Capture([string]$Exe, [string[]]$Arguments) {
    $result = & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "Tool failed ($LASTEXITCODE): $Exe" }
    return ($result -join "`n")
}
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Inside([string]$Path, [string]$Parent) {
    $p = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    return $Path.Equals($p, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($p + '\', [StringComparison]::OrdinalIgnoreCase)
}
function SafePath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.Length -lt 3 -or $full[1] -ne ':') { Fail 'Use an absolute local drive path.' }
    if ($full.StartsWith('\\') -or $full.Substring(2).Contains(':')) { Fail 'Use a local drive path without alternate data streams.' }
    $cursor = $full
    while ($cursor) {
        # Enumerate the directory entry, not target existence: dangling links must fail too.
        $parent = [IO.Path]::GetDirectoryName($cursor)
        $entry = $null
        if ($parent -and [IO.Directory]::Exists($parent)) {
            $leaf = [IO.Path]::GetFileName($cursor)
            $entry = Get-ChildItem -LiteralPath $parent -Force | Where-Object { $_.Name -eq $leaf }
        } elseif (-not $parent) {
            $entry = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        }
        if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail "Reparse points are not allowed: $cursor" }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}
function PrivateDirectory([string]$Path) {
    $full = SafePath $Path
    foreach ($forbidden in @($PSScriptRoot, [IO.Path]::GetTempPath())) {
        if (Inside $full $forbidden) { Fail 'Signing storage must be outside the package and temporary folders.' }
    }
    # Also reject any ancestor repository, including a source checkout launch.
    $ancestor = $full
    while ($ancestor) {
        if (Test-Path -LiteralPath (Join-Path $ancestor '.git')) { Fail 'Signing storage must be outside a repository.' }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    if ($full -match '(?i)[\\/](build|dist|out)([\\/]|$)') { Fail 'Do not use a build/output directory for signing storage.' }
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($full))
    if ($drive.DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable)) { Fail 'Choose a local fixed or removable drive.' }
    if ($full.TrimEnd('\') -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { Fail 'Choose a dedicated subfolder, never a drive root.' }
    if (Test-Path -LiteralPath $full) {
        AssertPrivateAcl $full
        return $full
    }
    [IO.Directory]::CreateDirectory($full) | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $full -AclObject $acl
    return $full
}
function AssertPrivateAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { Fail "Signing storage has an unexpected owner: $Path. Review ownership locally before proceeding." }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $allowed) {
            Fail "Existing signing storage is shared or has broad permissions: $Path. Choose a new dedicated backup folder or review its permissions yourself; no existing ACL was changed."
        }
    }
}
# Obtain file identity/link count without invoking a shell or passing a password.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BcornFileIdentity {
 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
  public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
 }
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
 public static Info Read(string path) {
  using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
   Info i; if (!GetFileInformationByHandle(f.SafeFileHandle, out i)) throw new IOException("Cannot inspect file identity");
   return i;
  }
 }
}
'@
function SingleFile([string]$Path) {
    $safe = SafePath $Path
    if (-not [IO.File]::Exists($safe)) { Fail "Missing file: $safe" }
    $identity = [BcornFileIdentity]::Read($safe)
    if ($identity.Links -ne 1) { Fail "Hard-linked signing/input files are not allowed: $safe" }
    return $identity
}
function CheckApk([string]$Path) {
    $badging = Capture $aapt @('dump', 'badging', $Path)
    if ($badging -notmatch "(?m)^package: name='com\.bcorn\.widget' versionCode='4' versionName='0\.3\.1'" -or $badging -match 'application-debuggable') {
        Fail 'APK must be non-debuggable com.bcorn.widget version 0.3.1 (4). No key was created for an invalid APK.'
    }
}
try {
    if ($env:OS -ne 'Windows_NT' -or $PSVersionTable.PSVersion.Major -lt 5) { Fail 'Use Windows PowerShell 5.1 or newer on your own Windows computer.' }
    if ([Console]::IsInputRedirected) { Fail 'Open an interactive terminal; do not pipe input or passwords.' }
    $metadataFull = SafePath $MetadataPath
    $metadata = Get-Content -LiteralPath $metadataFull -Raw | ConvertFrom-Json
    if ($metadata.package -ne 'com.bcorn.widget' -or $metadata.versionName -ne '0.3.1' -or $metadata.versionCode -ne 4 -or $metadata.sha256 -notmatch '^[0-9a-fA-F]{64}$') { Fail 'Invalid release metadata.' }
    if ([IO.Path]::GetFileName($metadata.apk) -ne $metadata.apk -or $metadata.apk -notmatch '\.apk$') { Fail 'Metadata must name an APK in this package folder.' }
    $source = SafePath (Join-Path ([IO.Path]::GetDirectoryName($metadataFull)) $metadata.apk)
    $null = SingleFile $source
    if ((Hash $source) -ne $metadata.sha256) { Fail 'Unsigned APK SHA-256 mismatch. Stop and obtain the verified package again.' }
    $javaHome = $env:JAVA_HOME
    if (-not $javaHome) {
        $javaCommand = Get-Command java.exe -ErrorAction SilentlyContinue
        if ($javaCommand) { $javaHome = Split-Path (Split-Path $javaCommand.Source) }
    }
    if (-not $javaHome) {
        $studioJbr = Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'
        if (Test-Path -LiteralPath (Join-Path $studioJbr 'bin\keytool.exe')) { $javaHome = $studioJbr }
    }
    if (-not $javaHome) { Fail 'Install a complete JDK 17+ from https://adoptium.net/temurin/releases/ and set JAVA_HOME. See WINDOWS_LOCAL_SIGNING.md.' }
    $java = Join-Path $javaHome 'bin\java.exe'
    $keytool = Join-Path $javaHome 'bin\keytool.exe'
    if (-not $BuildToolsPath) {
        $sdk = $env:ANDROID_SDK_ROOT
        if (-not $sdk) { $sdk = $env:ANDROID_HOME }
        if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
        $BuildToolsPath = Join-Path $sdk 'build-tools\35.0.0'
    }
    $aapt = Join-Path $BuildToolsPath 'aapt2.exe'
    $zipalign = Join-Path $BuildToolsPath 'zipalign.exe'
    $signer = Join-Path $BuildToolsPath 'lib\apksigner.jar'
    foreach ($tool in @($java, $keytool, $aapt, $zipalign, $signer)) {
        if (-not [IO.File]::Exists($tool)) { Fail "Missing official tool: $tool. Install JDK 17+ and Android SDK Build-Tools 35.0.0. See WINDOWS_LOCAL_SIGNING.md; https://developer.android.com/studio" }
    }
    CheckApk $source
    if ($ValidateOnly) { Write-Host 'Release hash, package, version and non-debuggable flag verified. No signing storage or key created.'; exit 0 }
    Write-Host 'Passwords stay in this local terminal. Never paste them into chat. Do not run with a transcript or screen recording.'
    $keyDir = PrivateDirectory (Join-Path $env:LOCALAPPDATA 'bcorn-signing')
    $key = SafePath (Join-Path $keyDir 'bcorn-release.p12')
    $backupInput = Read-Host 'Encrypted key backup folder (prefer a separate removable NTFS drive; no quotes)'
    if ([string]::IsNullOrWhiteSpace($backupInput) -or -not [IO.Path]::IsPathRooted($backupInput)) { Fail 'An absolute backup folder is required.' }
    $backupDir = SafePath $backupInput
    if ((Inside $backupDir $keyDir) -or (Inside $keyDir $backupDir)) { Fail 'Primary and backup folders must be separate, not nested.' }
    $backupDir = PrivateDirectory $backupDir
    $backup = SafePath (Join-Path $backupDir 'bcorn-release.p12')
    if ([IO.Path]::GetPathRoot($keyDir) -eq [IO.Path]::GetPathRoot($backupDir)) { Write-Warning 'Same drive: this is NOT an independent backup against drive/device loss.' }
    Write-Warning 'Different drive letters do not prove separate physical devices. Verify your backup device and retention yourself.'
    $stage = Join-Path $keyDir ('work-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $snapshot = Join-Path $stage 'verified-unsigned.apk'
    [IO.File]::Copy($source, $snapshot, $false)
    if ((Hash $snapshot) -ne $metadata.sha256) { Fail 'APK changed while being copied.' }
    CheckApk $snapshot
    if (Test-Path -LiteralPath $key) {
        $null = SingleFile $key
        AssertPrivateAcl $key
        Write-Host 'Reusing the existing signing identity. Enter its existing password when keytool asks.'
        Run $keytool @('-list', '-storetype', 'PKCS12', '-keystore', $key, '-alias', 'bcorn-release')
    } else {
        if (Test-Path -LiteralPath $backup) { Fail 'A backup already exists. Restore the original identity locally; never replace it with a new key.' }
        if ((Read-Host 'Create a NEW encrypted signing identity for com.bcorn.widget? Type CREATE') -cne 'CREATE') { Fail 'Cancelled; no new key created.' }
        Write-Host 'Choose a strong keystore password in the keytool prompt and save it in your password manager.'
        Run $keytool @('-genkeypair', '-storetype', 'PKCS12', '-keystore', $key, '-alias', 'bcorn-release', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=bcorn')
    }
    $primaryInfo = SingleFile $key
    if (Test-Path -LiteralPath $backup) {
        $null = SingleFile $backup
        AssertPrivateAcl $backup
        if ((Hash $key) -ne (Hash $backup)) { Fail 'Existing backup differs; it was not overwritten. Reconcile the correct identity locally.' }
    } else {
        # CreateNew refuses to overwrite any existing destination, including an alias.
        $inputStream = [IO.File]::OpenRead($key)
        try {
            $outputStream = New-Object IO.FileStream($backup, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) } finally { $outputStream.Dispose() }
        } finally { $inputStream.Dispose() }
    }
    $backupInfo = SingleFile $backup
    if ($primaryInfo.Volume -eq $backupInfo.Volume) { Write-Warning 'The backup is on the same filesystem; it is not independent protection.' }
    if (($primaryInfo.Volume -eq $backupInfo.Volume -and $primaryInfo.IndexHigh -eq $backupInfo.IndexHigh -and $primaryInfo.IndexLow -eq $backupInfo.IndexLow) -or (Hash $key) -ne (Hash $backup)) { Fail 'Encrypted key backup verification failed.' }
    Write-Host 'Two distinct matching encrypted files verified. This does not prove long-term backup durability.'
    $aligned = Join-Path $stage 'aligned.apk'
    $signed = Join-Path $stage 'bcorn-0.3.1-signed.apk'
    Run $zipalign @('-p', '4', $snapshot, $aligned)
    Run $java @('-jar', $signer, 'sign', '--ks', $key, '--ks-key-alias', 'bcorn-release', '--v4-signing-enabled', 'false', '--out', $signed, $aligned)
    Run $java @('-jar', $signer, 'verify', '--verbose', '--print-certs', $signed)
    Run $zipalign @('-c', '-p', '4', $signed)
    CheckApk $signed
    $outputDir = SafePath (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'bcorn-releases')
    if ((Inside $outputDir $keyDir) -or (Inside $outputDir $backupDir)) { Fail 'APK output must be separate from key storage.' }
    [IO.Directory]::CreateDirectory($outputDir) | Out-Null
    $output = Join-Path $outputDir ('bcorn-0.3.1-' + [Guid]::NewGuid().ToString('N') + '.apk')
    # Copy to a private destination-volume staging directory; rename only a verified complete file.
    $publishStage = PrivateDirectory (Join-Path $outputDir ('.staging-' + [Guid]::NewGuid().ToString('N')))
    try {
        $candidate = Join-Path $publishStage 'release.apk'
        [IO.File]::Copy($signed, $candidate, $false)
        if ((Hash $candidate) -ne (Hash $signed)) { Fail 'Output copy verification failed.' }
        [IO.File]::Move($candidate, $output)
    } finally { Remove-Item -LiteralPath $publishStage -Recurse -Force }
    Write-Host "SUCCESS: $output"
    Write-Host "APK SHA-256: $(Hash $output)"
    Write-Host 'Keep the key, password and backup. Future updates must reuse this identity. Nothing was uploaded.'
} catch {
    Write-Host ('STOPPED: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

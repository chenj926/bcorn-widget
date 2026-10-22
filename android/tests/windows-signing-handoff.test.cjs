const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const ps = fs.readFileSync(path.join(root, 'android/scripts/Sign-bcorn.ps1'), 'utf8');
const cmd = fs.readFileSync(path.join(root, 'android/scripts/Start-signing.cmd'), 'utf8');
test('Windows native entrypoint has no Python or security-policy bypass', () => {
  assert.match(cmd, /powershell\.exe -NoLogo -NoProfile -File/);
  assert.doesNotMatch(ps + cmd, /ExecutionPolicy|Unblock-File|\bpython\b|Invoke-WebRequest|Start-Transcript/i);
});
test('passwords stay in native interactive prompts', () => {
  assert.doesNotMatch(ps, /--ks-pass|--key-pass|-storepass|-keypass|Read-Host[^\n]*AsSecureString/);
  assert.match(ps, /IsInputRedirected/);
  assert.match(ps, /-cne 'CREATE'/);
});
test('verified immutable private snapshot precedes any key creation', () => {
  const checked = ps.indexOf('CheckApk $snapshot');
  const create = ps.indexOf("'-genkeypair'");
  assert.ok(checked > 0 && checked < create);
  assert.match(ps, /\(Hash \$snapshot\) -ne \$metadata.sha256/);
  assert.match(ps, /application-debuggable/);
  assert.match(ps, /versionCode='5' versionName='0\\.3\\.2'/);
  assert.match(ps, /Run \$zipalign @\('-p', '4', \$snapshot, \$aligned\)/);
});
test('keys and backups require distinct regular files and private persistent storage', () => {
  for (const check of ['ReparsePoint', 'Links -ne 1', 'IndexHigh', 'IndexLow', 'SetAccessRuleProtection', '[IO.FileMode]::CreateNew', 'GetTempPath', "'bcorn-signing'", 'same filesystem', 'does not prove']) assert.ok(ps.includes(check), check);
  assert.match(ps, /Existing backup differs/);
});
test('no public partial APK/idsig, no overwrites; verification precedes publication', () => {
  assert.match(ps, /'--v4-signing-enabled', 'false'/);
  const verify = ps.indexOf("'verify', '--verbose', '--print-certs'");
  const publish = ps.indexOf('[IO.File]::Move($candidate, $output)');
  assert.ok(verify > 0 && publish > verify);
  assert.match(ps, /\(Hash \$candidate\) -ne \(Hash \$signed\)/);
  assert.match(ps, /finally \{ Remove-Item -LiteralPath \$publishStage -Recurse -Force \}/);
  assert.match(ps, /Remove-Item -LiteralPath \$stage -Recurse -Force/);
});

test('dangling reparse entries checked before keytool can create a key', () => {
  assert.match(ps, /Get-ChildItem -LiteralPath \$parent -Force/);
  assert.match(ps, /\$key = SafePath \(Join-Path \$keyDir/);
  assert.match(ps, /\$backup = SafePath \(Join-Path \$backupDir/);
});

test('Windows -File entrypoint resolves metadata after binding, not in parameter default', () => {
  assert.match(ps, /param\(\[string\]\$MetadataPath,/);
  assert.doesNotMatch(ps.split('Set-StrictMode')[0], /Join-Path|\$PSScriptRoot/);
  assert.match(ps, /\$ScriptDirectory = \$PSScriptRoot/);
  assert.match(ps, /Split-Path -Parent \$MyInvocation.MyCommand.Path/);
  assert.match(ps, /\$MetadataPath = Join-Path \$ScriptDirectory 'release-metadata.json'/);
  assert.ok(ps.indexOf("if ($ValidateOnly)") < ps.indexOf("$keyDir = PrivateDirectory"));
});

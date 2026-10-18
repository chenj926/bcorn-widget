'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = 'app/src/main/java/com/acorn/widget/';

test('parallel install has a distinct application ID but preserves code/resource namespace', () => {
  const build = read('app/build.gradle.kts');
  assert.match(build, /applicationId = "com\.bcorn\.widget"/);
  assert.match(build, /namespace = "com\.acorn\.widget"/);
  assert.match(build, /versionCode = 4; versionName = "0\.3\.1"/);
  assert.match(build, /getByName\("debug"\) \{ signingConfig = null \}/);
  assert.match(build, /getByName\("release"\) \{ isDebuggable = false; signingConfig = null \}/);
});

test('manifest points to actual classes without shared identity or exposed deep links', () => {
  const manifest = read('app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:label="bcorn"/);
  assert.match(manifest, /android:name="com\.acorn\.widget\.MainActivity"/);
  assert.match(manifest, /android:name="com\.acorn\.widget\.TimetableWidgetProvider" android:exported="false"/);
  assert.doesNotMatch(manifest, /sharedUserId|<provider|android:authorities|<data\b/);
  // Metadata is a code-owned key, not a package lookup; keep OAuth explicitly disabled.
  assert.match(manifest, /android:name="com\.acorn\.widget\.GRADE_SYNC_CONFIGURED" android:value="false"/);
});

test('widget resources, explicit components and navigation remain in the running package', () => {
  const widget = read(source + 'TimetableWidgetProvider.kt');
  assert.match(widget, /RemoteViews\(context\.packageName,/);
  assert.doesNotMatch(widget, /RemoteViews\("|"com\.acorn\.widget\./);
  for (const action of ['PREVIOUS_WEEK', 'NEXT_WEEK', 'TODAY_WEEK', 'TOGGLE_DAY_WEEK']) {
    assert(widget.includes(`"com.bcorn.widget.${action}"`));
  }
  assert.match(widget, /Intent\(context, MainActivity::class\.java\)/);
  assert.match(widget, /Intent\(context, TimetableWidgetProvider::class\.java\)/);
  assert(widget.includes('bcorn-widget://${context.packageName}/week/$id/$action'));
  assert.match(widget, /PendingIntent\.FLAG_IMMUTABLE/);
});

test('storage uses app-private roots, never the legacy package data path', () => {
  for (const file of ['CacheStore.kt', 'GradeBookStore.kt', 'WidgetWeekStore.kt']) {
    assert.match(read(source + file), /context\.filesDir/);
  }
  assert.match(read(source + 'gradesync/GradeSyncStorage.kt'), /context\.noBackupFilesDir/);
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (file.endsWith('.kt')) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\/data\/(?:data|user)\/|createPackageContext\("com\.acorn\.widget"|setPackage\("com\.acorn\.widget"/);
    }
  }
  inspect(path.join(root, 'app/src/main/java'));
});

test('release manifest validator accepts isolated release and rejects old ID/debuggable/OAuth/conflicting authority', () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcorn-manifest-test-'));
  const file = path.join(dir, 'synthetic.xml');
  const manifest = read('app/src/main/AndroidManifest.xml').replace('<manifest xmlns:', '<manifest package="com.bcorn.widget" android:versionCode="4" android:versionName="0.3.1" xmlns:');
  const run = text => {
    fs.writeFileSync(file, text);
    const result = spawnSync('python3', [path.join(root, 'scripts/check-release-identity.py'), file], { encoding: 'utf8' });
    assert.ifError(result.error);
    return result;
  };
  try {
    assert.equal(run(manifest).status, 0);
    for (const invalid of [
      manifest.replace('package="com.bcorn.widget"', 'package="com.acorn.widget"'),
      manifest.replace('<application ', '<application android:debuggable="true" '),
      manifest.replace('android:value="false"', 'android:value="true"'),
      manifest.replace('</application>', '<provider android:name="synthetic.Provider" android:authorities="com.acorn.widget.provider"/></application>')
    ]) assert.notEqual(run(invalid).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

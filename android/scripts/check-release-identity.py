#!/usr/bin/env python3
"""Validate the actual AGP merged release manifest before signing; no SDK needed."""
import argparse
import xml.etree.ElementTree as ET
from pathlib import Path

ANDROID = '{http://schemas.android.com/apk/res/android}'
PACKAGE = 'com.bcorn.widget'

def check(path, expect_grade_sync="false"):
    if not __debug__:
        raise RuntimeError("Manifest validation requires Python assertions; remove -O/PYTHONOPTIMIZE")
    manifest = ET.parse(path).getroot()
    assert manifest.get('package') == PACKAGE, 'Wrong installed application ID'
    assert manifest.get(ANDROID + 'sharedUserId') is None, 'Shared UID is forbidden'
    assert manifest.get(ANDROID + 'versionCode') == '5', 'Unexpected versionCode'
    assert manifest.get(ANDROID + 'versionName') == '0.3.2', 'Unexpected versionName'
    app = manifest.find('application')
    assert app is not None
    assert app.get(ANDROID + 'debuggable', 'false') == 'false', 'Release must not be debuggable'
    assert app.get(ANDROID + 'testOnly', 'false') == 'false', 'Release must not be test-only'
    assert app.get(ANDROID + 'label') == 'bcorn', 'Unexpected application label'
    assert app.get(ANDROID + 'allowBackup') == 'false', 'Private data must remain excluded from backup'
    assert app.find("activity[@" + ANDROID + "name='com.acorn.widget.MainActivity']") is not None, 'Activity class must retain code namespace'
    widget = app.find("receiver[@" + ANDROID + "name='com.acorn.widget.TimetableWidgetProvider']")
    assert widget is not None and widget.get(ANDROID + 'exported') == 'false', 'Widget must target the non-exported production class'
    configured = app.find("meta-data[@" + ANDROID + "name='com.acorn.widget.GRADE_SYNC_CONFIGURED']")
    assert configured is not None and configured.get(ANDROID + 'value') == expect_grade_sync, 'Google sync build flag differs from explicitly expected mode'
    for provider in app.findall('provider'):
        for authority in provider.get(ANDROID + 'authorities', '').split(';'):
            assert authority.startswith(PACKAGE + '.'), f'Provider authority is not isolated: {authority}'
    print(f'PASS merged release manifest: parallel identity, private components/authorities, grade sync flag={expect_grade_sync}, non-debuggable; external OAuth setup not verified')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--expect-grade-sync', choices=['false', 'true'], default='false',
                        help='Must match the intentional build mode; default rejects enabled builds.')
    args = parser.parse_args()
    check(args.manifest, args.expect_grade_sync)

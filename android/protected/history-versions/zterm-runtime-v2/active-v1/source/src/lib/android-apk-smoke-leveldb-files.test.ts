import { describe, expect, it } from 'vitest';
import { buildApkSmokeLevelDbListArgs, parseApkSmokeLevelDbFileList } from './android-apk-smoke-leveldb-files';

describe('android apk smoke leveldb file listing', () => {
  it('uses exec-out run-as for leveldb ls so adb returns the app sandbox listing instead of the device shell root', () => {
    expect(buildApkSmokeLevelDbListArgs('com.zterm.android', './app_webview/Default/Local Storage/leveldb')).toEqual([
      'exec-out',
      'run-as',
      'com.zterm.android',
      'sh',
      '-lc',
      "cd './app_webview/Default/Local Storage/leveldb' && ls -1",
    ]);
  });

  it('parses trimmed leveldb filenames from adb output', () => {
    expect(parseApkSmokeLevelDbFileList('\n000005.ldb\n004223.log\nCURRENT\n')).toEqual([
      '000005.ldb',
      '004223.log',
      'CURRENT',
    ]);
  });
});


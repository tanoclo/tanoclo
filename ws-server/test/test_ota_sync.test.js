import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import AdmZip from 'adm-zip';
import otaSync from '../lib/ota-sync';

describe('OtaSyncManager', () => {
  let tmpDir;

  beforeEach(() => {
    otaSync.stopTimer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-test-'));
  });

  afterEach(() => {
    otaSync.stopTimer();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('provides default fallback manifest when no local file exists', () => {
    const manifest = otaSync.getManifest();
    expect(manifest).toBeDefined();
    expect(manifest.webVersionCode).toBeDefined();
    expect(manifest.apkVersionCode).toBeDefined();
  });

  it('extracts zip buffer into target directory correctly', () => {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html><body>Test OTA</body></html>'));
    const zipBuffer = zip.toBuffer();

    // Extract into isolated temp dir — NOT the real frontend-dist
    otaSync.extractZipBuffer(zipBuffer, tmpDir);

    const indexPath = path.join(tmpDir, 'index.html');
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = fs.readFileSync(indexPath, 'utf8');
    expect(content).toContain('Test OTA');

    // Verify real frontend-dist was NOT touched
    const realIndex = path.join(__dirname, '../frontend-dist/index.html');
    if (fs.existsSync(realIndex)) {
      const realContent = fs.readFileSync(realIndex, 'utf8');
      expect(realContent).not.toBe('<html><body>Test OTA</body></html>');
    }
  });
});

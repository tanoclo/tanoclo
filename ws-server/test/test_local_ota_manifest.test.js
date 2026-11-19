const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

function loadManifest(fixtures) {
    const filename = require.resolve('../lib/ota-sync');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const simulatedRoot = path.resolve('/test-ota');
    const files = new Map(Object.entries(fixtures).map(([file, data]) => [path.join(simulatedRoot, file), data]));
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, __dirname: path.join(simulatedRoot, 'lib'),
        require: name => name === 'fs' ? {
            existsSync: file => files.has(file),
            readFileSync: file => files.get(file)
        } : localRequire(name)
    }, { filename });
    return module.exports.getManifest();
}

test('ignores a PWA manifest in frontend-dist', () => {
    const manifest = loadManifest({ 'frontend-dist/manifest.json': '{"name":"TaNoClo","start_url":"/"}' });
    expect(manifest).toMatchObject({ webVersionCode: 1, apkVersionCode: 1 });
    expect(manifest).not.toHaveProperty('start_url');
});

test('falls through an invalid cache to genuine bundled OTA metadata', () => {
    const manifest = loadManifest({
        'data/ota/manifest.json': '{"webVersionCode":"12","apkVersionCode":9}',
        'frontend-dist/manifest.json': '{"webVersionCode":10,"apkVersionCode":8}'
    });
    expect(manifest).toMatchObject({ webVersionCode: 10, apkVersionCode: 8 });
});

test('prefers valid cached metadata to the bundle manifest', () => {
    const manifest = loadManifest({
        'data/ota/manifest.json': '{"webVersionCode":12,"apkVersionCode":9}',
        'frontend-dist/manifest.json': '{"webVersionCode":10,"apkVersionCode":8}'
    });
    expect(manifest).toMatchObject({ webVersionCode: 12, apkVersionCode: 9 });
});

/**
 * @file lib/device-registry.js
 * @brief Device registry managing MAC-to-serial bindings, states, and disk caching.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const rfCrypto = require('./rf-crypto.js');

class DeviceRegistry {
    constructor() {
        this.devicesByMac = new Map();     // cleanMac -> DeviceRecord
        this.devicesBySerial = new Map();  // serial -> DeviceRecord
        this.cacheFilePath = null;
        this.dirty = false;
    }

    /**
     * Initialize registry with optional persistent cache path.
     * @param {string} [cachePath]
     */
    init(cachePath) {
        if (cachePath) {
            this.cacheFilePath = cachePath;
        } else if (fs.existsSync('/data')) {
            this.cacheFilePath = '/data/discovered_devices.json';
        } else {
            this.cacheFilePath = path.join(__dirname, '../.discovered_devices.json');
        }

        this.loadCache();
    }

    cleanMac(mac) {
        if (!mac) return '';
        return mac.replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
    }

    cleanSerial(serial) {
        if (!serial) return '';
        return String(serial).trim().toUpperCase();
    }

    inferDeviceType(serial, mac, fields = null) {
        if (serial) {
            const s = serial.toUpperCase();
            if (s.startsWith('VA')) return 'VA02';
            if (s.startsWith('RU')) return 'RU02';
            if (s.startsWith('SU')) return 'SU02';
            if (s.startsWith('IB')) return 'IB01';
            if (s.startsWith('BP') || s.startsWith('BR')) return 'BP01';
            if (s.startsWith('WR')) return 'WR02';
        }
        if (mac) {
            const m = String(mac).toUpperCase();
            if (rfCrypto.isBridgeMac(m) || m.endsWith(':0E:82') || m.endsWith(':00:1E')) return 'IB01';
        }
        if (fields && typeof fields === 'object') {
            // 1. Device Type Code TLV (0x015d)
            if (fields['0x015d'] !== undefined) {
                const dt = Number(fields['0x015d']);
                if (dt === 0x70 || dt === 0x71 || dt === 112 || dt === 113) return 'VA02';
                if (dt === 0x47 || dt === 0xc8 || dt === 71 || dt === 200) return 'RU02';
            }
            // 2. Zone Binding / Topology Role TLV (0x015e)
            if (fields['0x015e'] !== undefined) {
                const rObj = fields['0x015e'];
                const role = typeof rObj === 'object' && rObj !== null ? rObj.role : Number(rObj);
                if (role === 0x05) return 'VA02';
                if (role === 0x03 || role === 0x09 || role === 0x0B || role === 0x02) return 'RU02';
                if (role === 0x0D) return 'IB01';
            }
            // 3. Actuator / Valve specific FIDs
            if (fields['0x0265'] !== undefined || fields['0x028c'] !== undefined ||
                fields['0x016a'] !== undefined || fields['0x0283'] !== undefined ||
                fields['0x0273'] !== undefined || fields['0x027c'] !== undefined ||
                fields['0x0280'] !== undefined || fields['0x0290'] !== undefined ||
                fields['0x0149'] !== undefined) {
                return 'VA02';
            }
            // 4. OpenTherm / Boiler specific FIDs
            if (fields['0x0161'] !== undefined || fields['0x0165'] !== undefined ||
                fields['0x044c'] !== undefined || fields['0x044d'] !== undefined ||
                fields['0x0457'] !== undefined || fields['0x0460'] !== undefined ||
                fields['0x045b'] !== undefined || fields['0x044f'] !== undefined) {
                return 'RU02';
            }
        }
        return 'UNKNOWN';
    }

    /**
     * Get or create a device record by MAC address or Serial.
     */
    getOrCreate(identifier, meta = {}) {
        if (!identifier) return null;
        const cleanId = String(identifier).trim().toUpperCase();
        const isMac = cleanId.includes(':') || cleanId.length === 16;
        const cMac = isMac ? this.cleanMac(cleanId) : null;
        const serial = !isMac ? this.cleanSerial(cleanId) : null;

        let record = null;
        if (cMac && this.devicesByMac.has(cMac)) {
            record = this.devicesByMac.get(cMac);
        } else if (serial && this.devicesBySerial.has(serial)) {
            record = this.devicesBySerial.get(serial);
        }

        if (!record) {
            const effectiveSerial = serial || meta.serial || null;
            const effectiveMac = isMac ? identifier : (meta.mac || null);
            const devType = meta.deviceType || this.inferDeviceType(effectiveSerial, effectiveMac, meta.fields);

            record = {
                mac: effectiveMac,
                cleanMac: cMac || (effectiveMac ? this.cleanMac(effectiveMac) : ''),
                serial: effectiveSerial,
                deviceType: devType,
                friendlyName: meta.friendlyName || null,
                isEmulated: false,
                fwVersion: meta.fwVersion || null,
                hardwareRevision: meta.hardwareRevision || null,
                lastSeen: new Date().toISOString(),
                rssi: null,
                state: {},
                discoveredAt: new Date().toISOString()
            };

            if (record.cleanMac) this.devicesByMac.set(record.cleanMac, record);
            if (record.serial) this.devicesBySerial.set(record.serial, record);
            this.dirty = true;
        } else if (record.deviceType === 'UNKNOWN') {
            const updatedType = meta.deviceType || this.inferDeviceType(record.serial || meta.serial, record.mac || meta.mac, meta.fields);
            if (updatedType !== 'UNKNOWN') {
                record.deviceType = updatedType;
                this.dirty = true;
            }
        }

        return record;
    }

    /**
     * Bind a MAC address to a known serial number and device type.
     */
    bindMacToSerial(mac, serial, deviceType = null, fields = null) {
        if (!mac || !serial) return;
        const cMac = this.cleanMac(mac);
        const cSerial = this.cleanSerial(serial);

        // Guard: never bind a peripheral serial (VA/RU) to a bridge MAC!
        if (rfCrypto.isBridgeMac(mac) && !cSerial.startsWith('IB')) {
            return;
        }

        if (cSerial.startsWith('IB')) {
            rfCrypto.addBridgeMac(mac);
        }

        let record = this.devicesBySerial.get(cSerial);
        if (!record && this.devicesByMac.has(cMac)) {
            record = this.devicesByMac.get(cMac);
        }

        if (!record) {
            record = this.getOrCreate(cSerial, { mac, deviceType, fields });
        }

        record.mac = mac;
        record.cleanMac = cMac;
        record.serial = cSerial;
        if (deviceType) record.deviceType = deviceType;
        else if (record.deviceType === 'UNKNOWN') record.deviceType = this.inferDeviceType(cSerial, mac, fields);

        // Check if emulated
        if (cSerial.startsWith('RU') && (record.fwVersion === '13762' || record.hardwareRevision === 4 || record.isEmulated)) {
            record.isEmulated = true;
        }

        this.devicesByMac.set(cMac, record);
        this.devicesBySerial.set(cSerial, record);
        this.dirty = true;
    }

    registerBridgeMac(mac) {
        if (!mac) return;
        const added = rfCrypto.addBridgeMac(mac);
        const cMac = this.cleanMac(mac);
        if (!cMac) return;
        let rec = this.devicesByMac.get(cMac);
        if (!rec) {
            rec = this.getOrCreate(mac, { deviceType: 'IB01' });
        } else if (rec.deviceType !== 'IB01') {
            rec.deviceType = 'IB01';
            this.dirty = true;
        }
        if (added || this.dirty) {
            this.saveCache();
        }
    }

    getDevice(identifier) {
        if (!identifier) return null;
        const cleanId = String(identifier).trim().toUpperCase();
        const isMac = cleanId.includes(':') || cleanId.length === 16;
        if (isMac) {
            return this.devicesByMac.get(this.cleanMac(cleanId)) || null;
        }
        return this.devicesBySerial.get(this.cleanSerial(cleanId)) || null;
    }

    updateState(identifier, stateUpdates, meta = {}) {
        const record = this.getOrCreate(identifier, meta);
        if (!record) return null;

        record.lastSeen = new Date().toISOString();
        if (meta.rssi !== undefined) record.rssi = meta.rssi;
        if (meta.serial && !record.serial) this.bindMacToSerial(record.mac, meta.serial, meta.deviceType);
        if (meta.fwVersion) record.fwVersion = meta.fwVersion;
        if (meta.hardwareRevision) record.hardwareRevision = meta.hardwareRevision;
        if (meta.isEmulated !== undefined) record.isEmulated = !!meta.isEmulated;
        if (record.serial && record.serial.startsWith('RU') && (record.fwVersion === '13762' || record.hardwareRevision === 4 || record.isEmulated)) {
            record.isEmulated = true;
        }

        Object.assign(record.state, stateUpdates);
        return record;
    }

    getAllDevices() {
        const set = new Set();
        for (const dev of this.devicesByMac.values()) set.add(dev);
        for (const dev of this.devicesBySerial.values()) set.add(dev);
        return Array.from(set);
    }

    loadCache() {
        if (!this.cacheFilePath || !fs.existsSync(this.cacheFilePath)) return;
        try {
            const raw = fs.readFileSync(this.cacheFilePath, 'utf8');
            const list = JSON.parse(raw);
            if (Array.isArray(list)) {
                for (const item of list) {
                    if (item && (item.mac || item.serial)) {
                        const rec = {
                            mac: item.mac || null,
                            cleanMac: item.mac ? this.cleanMac(item.mac) : '',
                            serial: item.serial || null,
                            deviceType: item.deviceType || 'UNKNOWN',
                            friendlyName: item.friendlyName || null,
                            isEmulated: !!item.isEmulated,
                            fwVersion: item.fwVersion || null,
                            hardwareRevision: item.hardwareRevision || null,
                            lastSeen: item.lastSeen || new Date().toISOString(),
                            rssi: item.rssi || null,
                            state: item.state || {},
                            discoveredAt: item.discoveredAt || new Date().toISOString()
                        };
                        if (rec.cleanMac) this.devicesByMac.set(rec.cleanMac, rec);
                        if (rec.serial) this.devicesBySerial.set(rec.serial, rec);
                        if (rec.deviceType === 'IB01' || (rec.serial && rec.serial.startsWith('IB'))) {
                            if (rec.mac) rfCrypto.addBridgeMac(rec.mac);
                        }
                    }
                }
            }
        } catch (err) {
            // Silently ignore corrupted cache read
        }
    }

    saveCache() {
        if (!this.cacheFilePath || !this.dirty) return;
        try {
            const all = this.getAllDevices();
            fs.writeFileSync(this.cacheFilePath, JSON.stringify(all, null, 2), 'utf8');
            this.dirty = false;
        } catch (err) {
            // Silently ignore errors (e.g. read-only filesystem)
        }
    }
}

module.exports = new DeviceRegistry();
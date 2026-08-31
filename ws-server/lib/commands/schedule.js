/**
 * @file lib/commands/schedule.js
 * @brief Schedule and active timetable block commands.
 */

'use strict';

const coap = require('../coap');
const tlv = require('../tlv');
const crypto = require('crypto');
const api = require('../command-api');

const OFFLINE_SCHEDULE_COAP_PATH = 'd/config';
const OFFLINE_SCHED_ENABLE_SETTING = 0x02b3;
const OFFLINE_SCHED_SETTING_IDS = {
    MONDAY: 0x029a,
    TUESDAY: 0x029b,
    WEDNESDAY: 0x029c,
    THURSDAY: 0x029d,
    FRIDAY: 0x029e,
    SATURDAY: 0x029f,
    SUNDAY: 0x02a0
};

function encodeLEB128(value) {
    const bytes = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0) byte |= 0x80;
        bytes.push(byte);
    } while (value !== 0);
    return Buffer.from(bytes);
}

function decodeLEB128(buf, offset = 0) {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;
    let byte;
    do {
        byte = buf[offset + bytesRead];
        value |= (byte & 0x7f) << shift;
        shift += 7;
        bytesRead++;
    } while (byte & 0x80);
    return { value, bytesRead };
}

function buildDayScheduleBlob(transitions) {
    const parts = [encodeLEB128(transitions.length)];
    for (const t of transitions) {
        parts.push(encodeLEB128(t.timeSeconds));
        parts.push(encodeLEB128(t.tempTenths));
    }
    return Buffer.concat(parts);
}

function timeToSeconds(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 3600 + m * 60;
}

function blocksToTransitions(blocks) {
    if (!blocks || blocks.length === 0) {
        return [{ timeSeconds: 0, tempTenths: 200 }];
    }

    const sorted = [...blocks].sort((a, b) => {
        const sa = timeToSeconds(a.start_time || a.start || '00:00');
        const sb = timeToSeconds(b.start_time || b.start || '00:00');
        return sa - sb;
    });

    return sorted.map(block => {
        const timeSeconds = timeToSeconds(block.start_time || block.start || '00:00');
        let tempTenths = 200;

        let settingType = block.setting_type;
        let settingPower = block.setting_power;
        let tempCelsius = block.setting_temp_celsius;

        if (settingType === undefined && settingPower === undefined && tempCelsius === undefined) {
            let setting = block.setting_json || block.setting;
            if (typeof setting === 'string') {
                try { setting = JSON.parse(setting); } catch (e) { setting = {}; }
            }
            if (setting) {
                settingType = setting.type;
                settingPower = setting.power;
                tempCelsius = setting.temperature?.celsius ?? null;
            }
        }

        if (settingPower === 'OFF') {
            tempTenths = 0;
        } else if (tempCelsius !== null && tempCelsius !== undefined) {
            tempTenths = Math.round(parseFloat(tempCelsius) * 10);
        }

        return { timeSeconds, tempTenths };
    });
}

async function pushOfflineScheduleEnable(homeId, zoneId, enabled) {
    const { isReadOnly, devBypass } = await api.checkZoneConfigReadonly(homeId);
    if (isReadOnly && !devBypass) throw new Error('Zone config modifications are disabled (readonly)');

    const pool = api._db.getPool();
    const dbDevices = await api._db.getDevicesInZone(homeId, zoneId);

    const vaDevices = dbDevices.filter(d => d.device_type && d.device_type.startsWith('VA'));
    if (vaDevices.length === 0) {
        throw new Error(`No VA devices found in zone ${zoneId}`);
    }

    const bridge = api.findBridgeForHome(homeId);
    if (!bridge) {
        throw new Error(`No bridge connected for home ${homeId}`);
    }

    const entries = [{
        fid: OFFLINE_SCHED_ENABLE_SETTING,
        value: Buffer.from([enabled ? 1 : 0])
    }];
    const payloadBuffer = tlv.encode(entries);

    let sentCount = 0;
    for (const dev of vaDevices) {
        if (!dev.ipv6_address) continue;

        api._log('info', `[cmd-api] Offline schedule ${enabled ? 'ENABLE' : 'DISABLE'} push to ${dev.serial_no} Z:${zoneId}`);

        const mid = (Math.random() * 0xFFFF) | 0;
        const token = crypto.randomBytes(4);

        const extraOptions = [
            { num: 7, value: Buffer.from([0xff, 0xff]) },
            { num: 12, value: Buffer.from([0x2a]) }
        ];

        const coapBytes = coap.buildRequest({
            code: coap.CODE_PUT,
            path: OFFLINE_SCHEDULE_COAP_PATH,
            token, mid,
            type: coap.TYPE_CON,
            payload: payloadBuffer,
            extraOptions
        });

        api.sendViaBridge(bridge.bridgeId, bridge.bridgeClient, dev.ipv6_address, dev.udp_port || 5683, coapBytes);
        sentCount++;
    }

    await pool.execute('UPDATE zones SET offline_schedule_enabled = ? WHERE id = ? AND home_id = ?', [enabled ? 1 : 0, zoneId, homeId]);

    api._log('info', `[cmd-api] Offline schedule ${enabled ? 'enabled' : 'disabled'} for zone ${zoneId}, pushed to ${sentCount} devices`);
    return { type: 'OfflineScheduleEnable', zoneId, enabled, devicesTargeted: sentCount };
}

async function pushOfflineScheduleSync(homeId, zoneId) {
    const { isReadOnly, devBypass } = await api.checkZoneConfigReadonly(homeId);
    if (isReadOnly && !devBypass) throw new Error('Zone config modifications are disabled (readonly)');

    const pool = api._db.getPool();

    const [ttRows] = await pool.execute(
        'SELECT id, type FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND is_active = 1 LIMIT 1',
        [zoneId, homeId]
    );
    if (ttRows.length === 0) {
        throw new Error(`No active timetable found for zone ${zoneId}`);
    }
    const timetableId = ttRows[0].id;
    const timetableType = ttRows[0].type;

    const [blockRows] = await pool.execute(
        'SELECT * FROM schedule_blocks WHERE timetable_id = ?',
        [timetableId]
    );

    const blocksByDay = {
        MONDAY: [], TUESDAY: [], WEDNESDAY: [], THURSDAY: [], FRIDAY: [], SATURDAY: [], SUNDAY: []
    };

    for (const block of blockRows) {
        const day = block.day_type;
        if (timetableType === 'ONE_DAY' || day === 'MONDAY_TO_SUNDAY') {
            Object.keys(blocksByDay).forEach(d => blocksByDay[d].push(block));
        } else if (timetableType === 'THREE_DAY') {
            if (day === 'MONDAY_TO_FRIDAY') {
                ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].forEach(d => blocksByDay[d].push(block));
            } else if (blocksByDay[day]) {
                blocksByDay[day].push(block);
            }
        } else if (timetableType === 'SEVEN_DAY') {
            if (blocksByDay[day]) blocksByDay[day].push(block);
        }
    }

    const tlvEntries = [];
    for (const [day, settingId] of Object.entries(OFFLINE_SCHED_SETTING_IDS)) {
        const transitions = blocksToTransitions(blocksByDay[day]);
        const dayBlob = buildDayScheduleBlob(transitions);
        tlvEntries.push({ fid: settingId, value: dayBlob });
    }

    const payloadBuffer = tlv.encode(tlvEntries);
    const dbDevices = await api._db.getDevicesInZone(homeId, zoneId);
    const vaDevices = dbDevices.filter(d => d.device_type && d.device_type.startsWith('VA'));
    if (vaDevices.length === 0) {
        throw new Error(`No VA devices found in zone ${zoneId} for schedule sync`);
    }

    const bridge = api.findBridgeForHome(homeId);
    if (!bridge) {
        throw new Error(`No bridge connected for home ${homeId}`);
    }

    let sentCount = 0;
    for (const dev of vaDevices) {
        if (!dev.ipv6_address) continue;

        api._log('info', `[cmd-api] Pushing daily schedule sync blocks to ${dev.serial_no} Z:${zoneId}`);

        const mid = (Math.random() * 0xFFFF) | 0;
        const token = crypto.randomBytes(4);

        const extraOptions = [
            { num: 7, value: Buffer.from([0xff, 0xff]) },
            { num: 12, value: Buffer.from([0x2a]) }
        ];

        const coapBytes = coap.buildRequest({
            code: coap.CODE_PUT,
            path: OFFLINE_SCHEDULE_COAP_PATH,
            token, mid,
            type: coap.TYPE_CON,
            payload: payloadBuffer,
            extraOptions
        });

        api.sendViaBridge(bridge.bridgeId, bridge.bridgeClient, dev.ipv6_address, dev.udp_port || 5683, coapBytes);
        sentCount++;
    }

    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    await pool.execute('UPDATE zones SET offline_schedule_synced_at = ? WHERE id = ? AND home_id = ?', [now, zoneId, homeId]);

    return { type: 'OfflineScheduleSync', zoneId, devicesTargeted: sentCount, syncedAt: now };
}

module.exports = {
    encodeLEB128,
    decodeLEB128,
    buildDayScheduleBlob,
    blocksToTransitions,
    pushOfflineScheduleEnable,
    pushOfflineScheduleSync
};

/**
 * @file ws-server/lib/memory-dumper.js
 * @brief Server-side background worker for sequential CoAP memory dumps.
 * 
 * Manages chunked over-the-air memory dumping (SRAM, Internal Flash, SPI Flash)
 * with single-in-flight dispatching to avoid Bridge queue congestion.
 */

const fs = require('fs');
const path = require('path');
const commandApi = require('./command-api');
const { getLogger } = require('./logger');

const _log = getLogger('memory-dumper');

const DUMPS_DIR = path.join(__dirname, '..', 'dumps');
if (!fs.existsSync(DUMPS_DIR)) {
    try {
        fs.mkdirSync(DUMPS_DIR, { recursive: true });
    } catch (e) {
        // Ignored if already created
    }
}

const _activeDumps = new Map();

/**
 * Starts or resumes a background memory dump job for a device.
 * @param {string} deviceId
 * @param {number|string} homeId
 * @param {string} startAdrHex
 * @param {number} totalBytes
 * @param {number} chunkSize
 * @param {boolean} restart If true, discards any existing .part file and starts over from byte 0.
 */
function startDump(deviceId, homeId, startAdrHex, totalBytes, chunkSize = 64, restart = false) {
    const existing = _activeDumps.get(deviceId);
    if (existing && existing.status === 'running' && !restart) {
        return getStatus(deviceId);
    }
    if (existing && existing.status === 'running' && restart) {
        existing.status = 'cancelled';
    }

    const cleanHex = (startAdrHex || '0').replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
    const startAdr = parseInt(cleanHex || '0', 16);
    const parsedTotal = Math.max(1, Math.min(4194304, Number(totalBytes) || 64)); // Max 4MB
    const parsedChunk = Math.max(1, Math.min(64, Number(chunkSize) || 64));

    const baseName = `${deviceId}_mem_${cleanHex.padStart(8, '0')}_${parsedTotal}B`;
    const fileName = `${baseName}.bin`;
    const partFileName = `${baseName}.part`;
    const dumpFilePath = path.join(DUMPS_DIR, fileName);
    const partFilePath = path.join(DUMPS_DIR, partFileName);

    let offset = 0;
    let bytesReceived = 0;
    const buffer = Buffer.alloc(parsedTotal);

    if (restart) {
        if (fs.existsSync(partFilePath)) {
            try { fs.unlinkSync(partFilePath); } catch (e) { /* ignore */ }
        }
        if (fs.existsSync(dumpFilePath)) {
            try { fs.unlinkSync(dumpFilePath); } catch (e) { /* ignore */ }
        }
        _log.info(`[dumper] Starting FRESH memory dump for ${deviceId} (discarded any .part): adr=0x${cleanHex.padStart(8, '0')} size=${parsedTotal}B`);
    } else if (fs.existsSync(partFilePath)) {
        try {
            const existingPart = fs.readFileSync(partFilePath);
            if (existingPart.length > 0 && existingPart.length <= parsedTotal) {
                existingPart.copy(buffer, 0, 0, existingPart.length);
                // Align offset to chunk boundary to prevent misalignment
                offset = existingPart.length - (existingPart.length % parsedChunk);
                bytesReceived = offset;
                // Truncate partial file to aligned offset
                fs.truncateSync(partFilePath, offset);
                _log.info(`[dumper] RESUMING memory dump for ${deviceId} from .part at offset ${offset}/${parsedTotal}B`);
            }
        } catch (readErr) {
            _log.warn(`[dumper] Could not read existing .part file: ${readErr.message}, starting from 0`);
            offset = 0;
            bytesReceived = 0;
        }
    }

    const job = {
        deviceId,
        homeId,
        startAdr,
        startAdrHex: cleanHex.padStart(8, '0'),
        totalBytes: parsedTotal,
        chunkSize: parsedChunk,
        offset,
        status: 'running',
        error: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        bytesReceived,
        buffer,
        dumpFilePath,
        partFilePath,
        fileName,
        partFileName,
        currentMid: null,
        recentChunks: []
    };

    _activeDumps.set(deviceId, job);

    // Launch worker loop in background
    _runDumpLoop(job).catch(err => {
        _log.error(`[dumper] Uncaught error in dump loop for ${deviceId}: ${err.message}`);
        job.status = 'error';
        job.error = err.message;
    });

    return getStatus(deviceId);
}

/**
 * Core sequential worker loop. Dispatches exactly 1 chunk at a time.
 */
async function _runDumpLoop(job) {
    while (job.status === 'running' && job.offset < job.totalBytes) {
        const curLen = Math.min(job.chunkSize, job.totalBytes - job.offset);
        const curAdr = job.startAdr + job.offset;
        const curAdrHex = curAdr.toString(16).padStart(8, '0');

        let chunkSuccess = false;
        let lastErr = null;

        for (let attempt = 1; attempt <= 4 && job.status === 'running'; attempt++) {
            try {
                _log.debug(`[dumper] Fetching chunk for ${job.deviceId}: adr=0x${curAdrHex} len=${curLen} (offset ${job.offset}/${job.totalBytes}, attempt ${attempt})`);
                const mid = await commandApi.pushDeviceDebug(job.deviceId, 'm', { adr: curAdrHex, len: curLen });
                job.currentMid = mid;

                // Wait up to 35 seconds for device ACK/Content payload
                const ack = await commandApi.waitForAck(mid, 35000);
                if (ack && (ack.payload || (ack.bytes && ack.bytes.length > 0))) {
                    const rawPayload = ack.payload ? (Buffer.isBuffer(ack.payload) ? ack.payload : Buffer.from(ack.payload)) : Buffer.from(ack.bytes);
                    const bytesToCopy = Math.min(rawPayload.length, curLen);

                    rawPayload.copy(job.buffer, job.offset, 0, bytesToCopy);

                    // Incrementally sync chunk to .part file on disk immediately
                    try {
                        fs.appendFileSync(job.partFilePath, rawPayload.slice(0, bytesToCopy));
                    } catch (writeErr) {
                        _log.warn(`[dumper] Failed to append chunk to .part file: ${writeErr.message}`);
                    }

                    job.offset += bytesToCopy;
                    job.bytesReceived += bytesToCopy;
                    job.updatedAt = new Date().toISOString();

                    // Store recent chunk preview for UI (last 64 bytes)
                    job.recentChunks.push({
                        offset: job.offset - bytesToCopy,
                        hex: rawPayload.slice(0, bytesToCopy).toString('hex')
                    });
                    if (job.recentChunks.length > 8) job.recentChunks.shift();

                    chunkSuccess = true;
                    break;
                }
            } catch (err) {
                lastErr = err;
                _log.debug(`[dumper] Chunk attempt ${attempt} failed for ${job.deviceId} at 0x${curAdrHex}: ${err.message}`);
                if (job.status !== 'running') break;
                // Wait briefly before retrying
                await new Promise(r => setTimeout(r, 600));
            }
        }

        if (!chunkSuccess && job.status === 'running') {
            _log.error(`[dumper] Failed to read chunk at 0x${curAdrHex} after 4 attempts for ${job.deviceId}: ${lastErr?.message || 'Timeout'}`);
            job.status = 'error';
            job.error = `Failed reading address 0x${curAdrHex}: ${lastErr?.message || 'Device timed out'}`;
            break;
        }

        // Small pause between chunks to keep radio buffer clear (50ms)
        await new Promise(r => setTimeout(r, 50));
    }

    if (job.status === 'running' && job.offset >= job.totalBytes) {
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        try {
            if (fs.existsSync(job.partFilePath)) {
                if (fs.existsSync(job.dumpFilePath)) {
                    try { fs.unlinkSync(job.dumpFilePath); } catch (e) { /* ignore */ }
                }
                fs.renameSync(job.partFilePath, job.dumpFilePath);
            } else {
                fs.writeFileSync(job.dumpFilePath, job.buffer);
            }
            _log.info(`[dumper] Memory dump COMPLETE for ${job.deviceId}. Saved ${job.bytesReceived}B to ${job.dumpFilePath}`);
        } catch (saveErr) {
            _log.error(`[dumper] Failed to finalize dump file for ${job.deviceId}: ${saveErr.message}`);
            job.status = 'error';
            job.error = `Failed to save file: ${saveErr.message}`;
        }
    }
}

/**
 * Returns the current status of a device dump, scanning for .part files if no active job.
 */
function getStatus(deviceId) {
    const job = _activeDumps.get(deviceId);
    if (job) {
        const percent = job.totalBytes > 0 ? Math.min(100, Math.round((job.bytesReceived / job.totalBytes) * 100)) : 0;
        const hasPart = fs.existsSync(job.partFilePath);
        return {
            isRunning: job.status === 'running',
            status: job.status,
            deviceId: job.deviceId,
            startAdrHex: job.startAdrHex,
            offset: job.offset,
            totalBytes: job.totalBytes,
            bytesReceived: job.bytesReceived,
            percent,
            error: job.error,
            startedAt: job.startedAt,
            updatedAt: job.updatedAt,
            completedAt: job.completedAt,
            fileName: job.fileName,
            hasFile: fs.existsSync(job.dumpFilePath),
            hasPart,
            partBytes: hasPart ? fs.statSync(job.partFilePath).size : 0,
            isResumable: hasPart && job.status !== 'running' && job.status !== 'completed',
            recentChunks: job.recentChunks
        };
    }

    // Check disk for partial or completed files
    let partInfo = null;
    let binInfo = null;
    try {
        const files = fs.readdirSync(DUMPS_DIR);
        for (const file of files) {
            if (file.startsWith(`${deviceId}_mem_`) && file.endsWith('.part')) {
                const stat = fs.statSync(path.join(DUMPS_DIR, file));
                partInfo = { fileName: file, size: stat.size };
            }
            if (file.startsWith(`${deviceId}_mem_`) && file.endsWith('.bin')) {
                const stat = fs.statSync(path.join(DUMPS_DIR, file));
                binInfo = { fileName: file, size: stat.size };
            }
        }
    } catch (e) {
        // Ignored
    }

    if (partInfo) {
        return {
            isRunning: false,
            status: 'paused',
            deviceId,
            hasPart: true,
            hasFile: false,
            partFileName: partInfo.fileName,
            partBytes: partInfo.size,
            bytesReceived: partInfo.size,
            isResumable: true,
            percent: 0,
            totalBytes: 0
        };
    }

    return {
        isRunning: false,
        status: 'idle',
        percent: 0,
        bytesReceived: 0,
        totalBytes: 0,
        hasPart: false,
        hasFile: !!binInfo,
        fileName: binInfo?.fileName || null
    };
}

/**
 * Cancels an active dump.
 */
function cancelDump(deviceId) {
    const job = _activeDumps.get(deviceId);
    if (job && job.status === 'running') {
        job.status = 'cancelled';
        job.updatedAt = new Date().toISOString();
        _log.info(`[dumper] Cancelled memory dump for ${deviceId} at offset ${job.offset}/${job.totalBytes}`);
        return { ok: true, message: 'Dump cancelled' };
    }
    return { ok: true, message: 'No active dump to cancel' };
}

/**
 * Gets file path for downloading.
 */
function getDumpFilePath(deviceId) {
    const job = _activeDumps.get(deviceId);
    if (job && fs.existsSync(job.dumpFilePath)) {
        return { filePath: job.dumpFilePath, fileName: job.fileName };
    }
    // Also check on disk if not in map
    try {
        const files = fs.readdirSync(DUMPS_DIR);
        for (const file of files) {
            if (file.startsWith(`${deviceId}_mem_`) && file.endsWith('.bin')) {
                return { filePath: path.join(DUMPS_DIR, file), fileName: file };
            }
        }
    } catch (e) {
        // Ignored
    }
    return null;
}

module.exports = {
    startDump,
    getStatus,
    cancelDump,
    getDumpFilePath
};

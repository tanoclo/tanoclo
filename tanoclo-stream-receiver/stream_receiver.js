/**
 * @file stream_receiver.js
 * @brief Main sniffer server that listens for raw RF capture packet streams over TCP.
 * 
 * Manages active TCP server ports, initializes cryptographic cipher decryptions, runs 6LoWPAN
 * fragmentation reassembly pipelines, parses inner CoAP request headers and payload TLVs,
 * and updates state caches published to MQTT.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const coapParser = require('./lib/coap');
const tlvDecoder = require('./lib/tlv');
const haDiscovery = require('./lib/ha-discovery');

// Global variables for clean shutdown and memory management
let tcpServer = null;
const activeSockets = new Set();
let globalReassembler = null;

// Configuration Defaults
const config = {
    tcpPort: 9999,
    tcpHost: "0.0.0.0", // default bind address
    fileLogging: true,
    consoleLogging: true,
    autoExclusion: true,
    keys: {
        "PAIRING": "7461646f2070616972696e67206b6579"
    },
    whitelistedPanIds: [],
    mqtt: {
        enabled: false,
        host: "mqtt://localhost",
        topic: "tado/sniffer",
        username: "",
        password: ""
    }
};

// 1. Load from config.json if exists
const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
    try {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (fileConfig.tcpPort !== undefined) config.tcpPort = fileConfig.tcpPort;
        if (fileConfig.fileLogging !== undefined) config.fileLogging = fileConfig.fileLogging;
        if (fileConfig.consoleLogging !== undefined) config.consoleLogging = fileConfig.consoleLogging;
        if (fileConfig.autoExclusion !== undefined) config.autoExclusion = !!fileConfig.autoExclusion;
        if (fileConfig.auto_exclusion !== undefined) config.autoExclusion = !!fileConfig.auto_exclusion;
        if (fileConfig.tcpHost !== undefined) config.tcpHost = fileConfig.tcpHost;
        if (fileConfig.bindAddress !== undefined) config.tcpHost = fileConfig.bindAddress;
        if (fileConfig.keys) Object.assign(config.keys, fileConfig.keys);
        if (fileConfig.whitelistedPanIds) config.whitelistedPanIds = fileConfig.whitelistedPanIds;
        if (fileConfig.mqtt) Object.assign(config.mqtt, fileConfig.mqtt);
    } catch (err) {
        console.error(`Error parsing config.json: ${err.message}`);
    }
}

// 2. Load from Environment Variables
if (process.env.TCP_PORT) config.tcpPort = parseInt(process.env.TCP_PORT, 10);
if (process.env.TCP_HOST) config.tcpHost = process.env.TCP_HOST;
if (process.env.BIND_ADDRESS) config.tcpHost = process.env.BIND_ADDRESS;
if (process.env.TADO_KEYS) {
    process.env.TADO_KEYS.split(',').forEach(part => {
        const [name, key] = part.split('=');
        if (name && key) config.keys[name.trim()] = key.trim();
    });
}
if (process.env.TADO_PAN_IDS) {
    config.whitelistedPanIds = process.env.TADO_PAN_IDS.split(',').map(id => {
        const trimmed = id.trim();
        return trimmed.startsWith('0x') ? parseInt(trimmed, 16) : parseInt(trimmed, 10);
    });
}
if (process.env.MQTT_ENABLED) config.mqtt.enabled = process.env.MQTT_ENABLED === 'true';
if (process.env.MQTT_HOST) config.mqtt.host = process.env.MQTT_HOST;
if (process.env.MQTT_TOPIC) config.mqtt.topic = process.env.MQTT_TOPIC;
if (process.env.MQTT_USERNAME) config.mqtt.username = process.env.MQTT_USERNAME;
if (process.env.MQTT_PASSWORD) config.mqtt.password = process.env.MQTT_PASSWORD;
if (process.env.FILE_LOGGING !== undefined) config.fileLogging = process.env.FILE_LOGGING === 'true';
if (process.env.CONSOLE_LOGGING !== undefined) config.consoleLogging = process.env.CONSOLE_LOGGING === 'true';
if (process.env.AUTO_EXCLUSION !== undefined) config.autoExclusion = process.env.AUTO_EXCLUSION === 'true' || process.env.AUTO_EXCLUSION === '1';

// 3. Load from Command Line Arguments
const args = process.argv;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
        config.tcpPort = parseInt(args[i + 1], 10);
    } else if (args[i] === '--host' && args[i + 1]) {
        config.tcpHost = args[i + 1];
    } else if (args[i] === '--keys' && args[i + 1]) {
        args[i + 1].split(',').forEach(part => {
            const [name, key] = part.split('=');
            if (name && key) config.keys[name.trim()] = key.trim();
        });
    } else if (args[i] === '--panids' && args[i + 1]) {
        config.whitelistedPanIds = args[i + 1].split(',').map(id => {
            const trimmed = id.trim();
            return trimmed.startsWith('0x') ? parseInt(trimmed, 16) : parseInt(trimmed, 10);
        });
    } else if (args[i] === '--mqtt-host' && args[i + 1]) {
        config.mqtt.enabled = true;
        config.mqtt.host = args[i + 1];
    } else if (args[i] === '--mqtt-topic' && args[i + 1]) {
        config.mqtt.topic = args[i + 1];
    } else if (args[i] === '--mqtt-user' && args[i + 1]) {
        config.mqtt.username = args[i + 1];
    } else if (args[i] === '--mqtt-pass' && args[i + 1]) {
        config.mqtt.password = args[i + 1];
    } else if (args[i] === '--auto-exclusion' && args[i + 1]) {
        config.autoExclusion = args[i + 1] === 'true' || args[i + 1] === '1';
    } else if (args[i] === '--no-auto-exclusion') {
        config.autoExclusion = false;
    }
}
if (args.includes('--no-file-logging')) config.fileLogging = false;
if (args.includes('--file-logging')) config.fileLogging = true;
if (args.includes('--no-console-logging')) config.consoleLogging = false;
if (args.includes('--console-logging')) config.consoleLogging = true;

// Encryption keys
const KEYS = [];
const KEY_NAMES = new Map(); // hex string → friendly name (avoids Buffer reference fragility)
for (const [name, hexKey] of Object.entries(config.keys)) {
    const keyBuf = Buffer.from(hexKey, 'hex');
    KEYS.push(keyBuf);
    KEY_NAMES.set(hexKey.toLowerCase(), name);
}

// Log file to save decrypted traffic - prefer /share/tanoclo for HA Samba/File Editor access, fall back to /data or __dirname
let LOG_DIR = __dirname;
if (fs.existsSync('/share')) {
    LOG_DIR = path.join('/share', 'tanoclo');
    if (!fs.existsSync(LOG_DIR)) {
        try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { }
    }
} else if (fs.existsSync('/data')) {
    LOG_DIR = '/data';
}
const LIVE_LOG_PATH = path.resolve(LOG_DIR, 'live_decrypted.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

// Whitelisted PAN IDs for our network
const explicitPanSet = new Set(
    config.whitelistedPanIds.map(id => typeof id === 'string' && id.startsWith('0x') ? parseInt(id, 16) : Number(id))
);
const hasExplicitWhitelist = explicitPanSet.size > 0;
const whitelistedPanIds = explicitPanSet;
const discoveredPanIds = new Set();
const excludedPanIds = new Set();


const PRINT_STATS = process.argv.includes('--stats');

// Statistical tracking counters to correlate with sniffer metrics (Mutually Exclusive Partition)
let statsTcpReceived = 0;        // Total TCP messages received
let statsTooShort = 0;          // msg.length < 3
let statsCrcFailed = 0;         // crc_ok === false
let statsDuplicateRaw = 0;      // processedPackets duplicate within 1s
let statsShortFrame = 0;        // frame too short or mismatching length
let statsNotEncrypted = 0;      // frame security bit !== 0x09
let statsDecryptionFailed = 0;  // CCM decryption failed for all keys
let statsNonOperational = 0;    // Decrypted, but innerProto !== 0x04 (e.g. ICMPv6)
let statsNoCoap = 0;            // Decrypted, innerProto === 0x04, but no CoAP header
let statsIncompleteFragment = 0;// 6LoWPAN incomplete fragment
let statsDecodedCoap = 0;       // Successfully parsed CoAP message (unfragmented or reassembled)

// Sub-counters for specific details
let statsDecodedCoapUnique = 0;
let statsDecodedCoapDuplicate = 0;
let statsReassembledComplete = 0;

// Setup MQTT Client if enabled
let mqttClient = null;
if (config.mqtt && config.mqtt.enabled) {
    try {
        const mqtt = require('mqtt');
        const options = {};
        if (config.mqtt.username) options.username = config.mqtt.username;
        if (config.mqtt.password) options.password = config.mqtt.password;

        console.log(`[MQTT] Connecting to broker at ${config.mqtt.host}...`);
        mqttClient = mqtt.connect(config.mqtt.host, options);

        // Initialize HA Discovery module
        const haDiscovery = require('./lib/ha-discovery');
        haDiscovery.init(mqttClient, config);

        mqttClient.on('connect', () => {
            console.log(`[MQTT] Connected successfully to broker at ${config.mqtt.host}`);
            try {
                haDiscovery.publishReceiverDiscovery();
                haDiscovery.publishReceiverStats({
                    statsTcpReceived,
                    statsCrcFailed,
                    statsDuplicateRaw,
                    statsDecryptionFailed,
                    statsDecodedCoap,
                    whitelistedPanIdsSize: whitelistedPanIds.size
                });
            } catch (err) {
                console.error(`[HA Discovery] Error on connect: ${err.message}`);
            }
        });
        mqttClient.on('error', (err) => {
            console.error(`[MQTT] Broker error: ${err.message}`);
        });
    } catch (err) {
        console.error(`[MQTT] Failed to initialize MQTT client: ${err.message}`);
    }
}

// Sliding window cache to prevent logging/processing duplicate packets
const processedPackets = new Map();

// Sliding window cache to prevent logging duplicate CoAP transactions (e.g. from network-level retransmissions)
const printedCoapPackets = new Map();

// Helper to extract the PAN ID from a raw packet if possible
function getPanId(rawBytes) {
    if (rawBytes.length < 6) return null;
    const rxLen = rawBytes[0];
    if (rxLen < 15 || rxLen > rawBytes.length - 1) return null;

    const frame = Buffer.alloc(rxLen);
    rawBytes.copy(frame, 0, 1, 1 + rxLen);

    // Security enabled Data Frame check (FCF low 4 bits = 0x09)
    if ((frame[0] & 0x0F) !== 0x09) return null;

    const panId = frame[3] | (frame[4] << 8);
    return panId;
}

// MID to URI Path cache for matching ACK/RST packets
const midCache = new Map();
function cacheMidPath(mid, pathStr) {
    if (mid === undefined || !pathStr || pathStr === 'Unknown') return;
    midCache.set(mid, pathStr);
    if (midCache.size > 1000) {
        const firstKey = midCache.keys().next().value;
        midCache.delete(firstKey);
    }
}
function getPathForMid(mid, currentPath) {
    if (currentPath && currentPath !== 'Unknown') return currentPath;
    if (mid !== undefined && midCache.has(mid)) {
        return midCache.get(mid);
    }
    return currentPath || 'Unknown';
}

function findCoapOffsetInFrag1(decrypted) {
    if (decrypted.length <= 13) return -1;
    const offset = findCoapOffset(decrypted.slice(9));
    return offset !== -1 ? offset + 9 : -1;
}

class SixLoWPANReassembler {
    constructor() {
        this.datagrams = new Map();
        this.completedTags = new Map();
    }

    process(decrypted, timestamp) {
        if (decrypted.length <= 5) {
            return { type: 'unfragmented', data: decrypted };
        }

        const dispatch = decrypted[8];
        const isFrag1 = (dispatch & 0xF8) === 0xC0;
        const isFragn = (dispatch & 0xF8) === 0xE0;

        if (!isFrag1 && !isFragn) {
            return { type: 'unfragmented', data: decrypted };
        }

        const size = ((decrypted[8] & 0x07) << 8) | decrypted[9];
        const tag = (decrypted[10] << 8) | decrypted[11];

        // Filter out duplicate fragments for recently completed datagrams
        const now = Date.now();
        if (this.completedTags.has(tag)) {
            const completedTime = this.completedTags.get(tag);
            if (now - completedTime < 10000) {
                return { type: 'duplicate_fragment', tag };
            } else {
                this.completedTags.delete(tag);
            }
        }

        // 10-second tag freshness check
        const currentSecs = parseTimestampToSeconds(timestamp);
        if (this.datagrams.has(tag)) {
            const dg = this.datagrams.get(tag);
            if (currentSecs !== null && dg.lastSecs !== null) {
                let diff = currentSecs - dg.lastSecs;
                if (diff < 0) diff += 86400; // Midnight rollover
                if (diff > 10) {
                    this.datagrams.delete(tag);
                }
            }
        }

        if (!this.datagrams.has(tag)) {
            this.datagrams.set(tag, {
                size,
                tag,
                fragments: new Map(),
                lines: [],
                lastSecs: currentSecs,
                senderShort: decrypted.slice(5, 7),
                prefix: decrypted[7],
                completed: false,
                expansion: 40, // default fallback
                compressedSize: size - 40,
                hasExactExpansion: false,
                createdAt: Date.now()
            });
        }

        const dg = this.datagrams.get(tag);
        dg.lastSecs = currentSecs;

        let compressedOffset = 0;
        let payload;
        let fragType;

        if (isFrag1) {
            fragType = 'FRAG1';
            compressedOffset = 0;
            payload = decrypted.slice(12); // 5-byte prefix + 3-byte net prefix + 4-byte FRAG1 header
            dg.frag1_decrypted = decrypted;

            // Calculate precise expansion dynamically
            const coapOffset = findCoapOffsetInFrag1(decrypted);
            if (coapOffset !== -1) {
                const preciseExpansion = 48 - (coapOffset - 12);
                if (preciseExpansion !== dg.expansion || !dg.hasExactExpansion) {
                    const oldExpansion = dg.expansion;
                    dg.expansion = preciseExpansion;
                    dg.compressedSize = size - preciseExpansion;
                    dg.hasExactExpansion = true;

                    // Re-key existing FRAGN fragments using the new correct expansion
                    const oldFragments = Array.from(dg.fragments.entries());
                    dg.fragments.clear();
                    for (const [oldOffset, fragPayload] of oldFragments) {
                        if (oldOffset === 0) {
                            dg.fragments.set(0, fragPayload);
                        } else {
                            const uncompressedOffset = oldOffset + oldExpansion;
                            const newOffset = uncompressedOffset - preciseExpansion;
                            dg.fragments.set(newOffset, fragPayload);
                        }
                    }

                    // Update offsets in dg.lines as well
                    for (const line of dg.lines) {
                        if (line.type === 'FRAGN') {
                            const uncompressedOffset = line.offset + oldExpansion;
                            line.offset = uncompressedOffset - preciseExpansion;
                        }
                    }
                }
            }
        } else {
            fragType = 'FRAGN';
            if (decrypted.length < 13) {
                return { type: 'unfragmented', data: decrypted };
            }
            const uncompressedOffset = decrypted[12] * 8;
            compressedOffset = uncompressedOffset - dg.expansion;
            payload = decrypted.slice(13); // 5-byte prefix + 3-byte net prefix + 5-byte FRAGN header
        }

        dg.fragments.set(compressedOffset, payload);
        dg.lines.push({ timestamp, type: fragType, offset: compressedOffset, length: payload.length });

        const completeBuffer = this.checkComplete(tag);
        const progress = this.getProgress(tag);
        const missingParts = this.getMissingParts(dg);

        if (completeBuffer) {
            dg.completed = true;
            this.datagrams.delete(tag);
            this.completedTags.set(tag, Date.now());

            // Housekeeping for completedTags cache
            if (this.completedTags.size > 200) {
                const cutoff = Date.now() - 30000;
                for (const [t, ts] of this.completedTags.entries()) {
                    if (ts < cutoff) {
                        this.completedTags.delete(t);
                    }
                }
            }

            // Prepend original senderShort (2 bytes) and prefix (1 byte)
            const finalBuffer = Buffer.concat([dg.senderShort, Buffer.from([dg.prefix]), completeBuffer]);

            return {
                type: 'complete',
                tag,
                size,
                data: finalBuffer,
                dgInfo: dg,
                progress
            };
        } else {
            return {
                type: 'incomplete',
                tag,
                size,
                offset: compressedOffset,
                length: payload.length,
                fragType,
                progress,
                missingParts
            };
        }
    }

    checkComplete(tag) {
        const dg = this.datagrams.get(tag);
        if (!dg) return null;

        const sortedOffsets = Array.from(dg.fragments.keys()).sort((a, b) => a - b);
        let currentOffset = 0;
        const pieces = [];

        for (const offset of sortedOffsets) {
            const fragData = dg.fragments.get(offset);
            const fragEnd = offset + fragData.length;

            if (offset <= currentOffset && fragEnd > currentOffset) {
                const skip = currentOffset - offset;
                pieces.push(fragData.slice(skip));
                currentOffset = fragEnd;
            } else if (fragEnd <= currentOffset) {
                continue;
            } else {
                break;
            }
        }

        const targetSize = dg.compressedSize;
        if (currentOffset >= targetSize) {
            let combined = Buffer.concat(pieces);
            if (combined.length > targetSize) {
                combined = combined.slice(0, targetSize);
            }
            return combined;
        }
        return null;
    }

    getProgress(tag) {
        const dg = this.datagrams.get(tag);
        if (!dg) return null;

        let receivedBytes = 0;
        const offsets = Array.from(dg.fragments.keys()).sort((a, b) => a - b);
        for (const offset of offsets) {
            receivedBytes += dg.fragments.get(offset).length;
        }

        const targetSize = dg.compressedSize;
        return {
            receivedBytes,
            totalSize: targetSize,
            offsets,
            percent: Math.min(100, Math.round((receivedBytes / targetSize) * 100))
        };
    }

    getMissingParts(dg) {
        const missing = [];
        if (!dg.fragments.has(0)) {
            missing.push('FRAG1 (offset 0)');
        }
        let currentOffset = 0;
        const sortedOffsets = Array.from(dg.fragments.keys()).sort((a, b) => a - b);
        for (const offset of sortedOffsets) {
            if (offset > currentOffset) {
                missing.push(`Gap [offset ${currentOffset} to ${offset}]`);
            }
            currentOffset = offset + dg.fragments.get(offset).length;
        }
        const targetSize = dg.compressedSize;
        if (currentOffset < targetSize) {
            missing.push(`End tail [offset ${currentOffset} to ${targetSize}]`);
        }
        return missing.join(', ') || 'None';
    }

    cleanup() {
        const now = Date.now();
        for (const [tag, dg] of this.datagrams.entries()) {
            if (now - dg.createdAt > 30000) {
                this.datagrams.delete(tag);
            }
        }
    }
}

function parseTimestampToSeconds(ts) {
    if (!ts || ts === 'Unknown') return null;
    const parts = ts.split(':');
    if (parts.length !== 3) return null;
    const hrs = parseInt(parts[0], 10);
    const mins = parseInt(parts[1], 10);
    const secs = parseInt(parts[2], 10);
    if (isNaN(hrs) || isNaN(mins) || isNaN(secs)) return null;
    return hrs * 3600 + mins * 60 + secs;
}

function isValidCoap(parsed) {
    if (!parsed.ok) return false;
    if (parsed.ver !== 1) return false;

    // Type must be 0-3 (CON, NON, ACK, RST)
    if (parsed.type < 0 || parsed.type > 3) return false;

    // Code class must be 0 (Request), 2 (Success), 4 (Client Error), or 5 (Server Error)
    const cls = (parsed.code >> 5) & 0x07;
    if (cls !== 0 && cls !== 2 && cls !== 4 && cls !== 5) return false;

    // Empty message validation
    if (parsed.code === 0) {
        // Empty message MUST have type ACK (2) or RST (3)
        if (parsed.type !== 2 && parsed.type !== 3) return false;
        // Empty message MUST NOT have a token
        if (parsed.tkl !== 0) return false;
        // Empty message MUST NOT have options
        if (parsed.options && parsed.options.length > 0) return false;
        // Empty message MUST NOT have payload
        if (parsed.payload && parsed.payload.length > 0) return false;
    } else {
        // Non-empty message MUST NOT be type RST (3)
        if (parsed.type === 3) return false;
    }

    return true;
}

function findCoapOffset(payload) {
    if (payload.length <= 4) return -1;
    const firstByte = payload[4];

    // 1. Try deterministic offsets first to prevent false positives on UDP header bytes
    const candidates = [];
    if (firstByte === 0x33) {
        candidates.push(12); // Correct offset for 0x33
    } else if (firstByte === 0xF7) {
        candidates.push(13); // Correct offset for 0xF7
    } else if (firstByte === 0xF5) {
        candidates.push(21); // Correct offset for 0xF5
    } else if (firstByte === 0xD7) {
        candidates.push(22); // Correct offset for 0xD7
    }

    for (const offset of candidates) {
        if (offset <= payload.length - 4) {
            const parsed = coapParser.parse(payload.subarray(offset));
            if (isValidCoap(parsed)) {
                return offset;
            }
        }
    }

    // 2. Fallback: Search starting from index 10 to avoid matching on early UDP header bytes
    for (let i = 10; i <= payload.length - 4; i++) {
        const parsed = coapParser.parse(payload.subarray(i));
        if (isValidCoap(parsed)) {
            return i;
        }
    }
    return -1;
}

// Decrypt AES-128-ECB
function decryptAES128ECB(ciphertext, key) {
    try {
        const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
        decipher.setAutoPadding(false);
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted;
    } catch (err) {
        return null;
    }
}

// AES-128-CCM Decryption
function decryptCCM(frame, key) {
    if (frame.length < 21) return null;
    const nonce = frame.slice(0, 13);
    const aad = frame.slice(0, 16);
    const ciphertextWithMic = frame.slice(16);
    const ciphertext = ciphertextWithMic.slice(0, -4);
    const tag = ciphertextWithMic.slice(-4);

    try {
        const decipher = crypto.createDecipheriv('aes-128-ccm', key, nonce, {
            authTagLength: 4
        });
        decipher.setAAD(aad, { plaintextLength: ciphertext.length });
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted;
    } catch (err) {
        return null;
    }
}

// MAC Layer Address Decoding
function decodeMAC(frame, decrypted) {
    const fcf = frame.readUInt16LE(0);
    const frameType = fcf & 0x07;
    const destMode = (fcf >> 10) & 0x03;
    const srcMode = (fcf >> 14) & 0x03;

    let pos = 3; // after FCF (2) and Seq (1)
    let destPan = null;
    let destShort = null;
    let destExtBytes = null;

    if (destMode > 0) {
        destPan = frame.readUInt16LE(pos);
        pos += 2;
    }

    if (destMode === 2) {
        destShort = frame.readUInt16LE(pos);
        pos += 2;
    } else if (destMode === 3) {
        const isStandardData = (frameType === 1);
        if (isStandardData) {
            destExtBytes = frame.subarray(pos, pos + 6);
            pos += 6;
        } else {
            destExtBytes = frame.subarray(pos, pos + 8);
            pos += 8;
        }
    }

    let srcShort = null;
    let srcExtBytes = null;

    if (srcMode === 2) {
        srcShort = frame.readUInt16LE(pos);
        pos += 2;
    } else if (srcMode === 3) {
        const isStandardData = (frameType === 1);
        if (isStandardData) {
            srcExtBytes = frame.subarray(pos, pos + 5);
            pos += 5;
        } else {
            srcExtBytes = frame.subarray(pos, pos + 8);
            pos += 8;
        }
    }

    // Format Dest MAC
    let dstMac = '00:00:00:00:00:00:00:00';
    let dstShortStr = destShort !== null ? destShort.toString(16).toUpperCase().padStart(4, '0') : '';
    if (destMode === 2) {
        if (destShort === 0xFFFF) {
            dstMac = '00:1B:C5:07:FF:FF:FF:FF';
        } else {
            const isIb = (destShort === 0x0E82 || destShort === 0x001E);
            const middle = isIb ? '31:55' : '31:56';
            dstMac = `00:1B:C5:07:${middle}:${dstShortStr.slice(0, 2)}:${dstShortStr.slice(2, 4)}`;
        }
    } else if (destMode === 3 && destExtBytes) {
        if (destExtBytes.length === 6) {
            const b = Buffer.alloc(8);
            b[0] = (destPan & 0xFF);
            b[1] = (destPan >> 8) & 0xFF;
            destExtBytes.copy(b, 2);
            dstMac = Buffer.from(b).reverse().toString('hex').toUpperCase().match(/.{1,2}/g).join(':');
        } else if (destExtBytes.length === 8) {
            dstMac = Buffer.from(destExtBytes).reverse().toString('hex').toUpperCase().match(/.{1,2}/g).join(':');
        }
    }

    // Format Src MAC
    let srcMac = '00:00:00:00:00:00:00:00';
    let srcShortStr = srcShort !== null ? srcShort.toString(16).toUpperCase().padStart(4, '0') : '';
    if (srcMode === 2) {
        const isIb = (srcShort === 0x0E82 || srcShort === 0x001E);
        const middle = isIb ? '31:55' : '31:56';
        srcMac = `00:1B:C5:07:${middle}:${srcShortStr.slice(0, 2)}:${srcShortStr.slice(2, 4)}`;
    } else if (srcMode === 3 && srcExtBytes) {
        if (srcExtBytes.length === 5) {
            const b = Buffer.alloc(8);
            b[0] = srcExtBytes[0];
            b[1] = srcExtBytes[1];
            b[2] = srcExtBytes[2];
            b[3] = srcExtBytes[3];
            b[4] = srcExtBytes[4];
            if (decrypted && decrypted.length >= 3) {
                b[5] = decrypted[0];
                b[6] = decrypted[1];
                b[7] = decrypted[2];
            } else {
                b[5] = 0xC5;
                b[6] = 0x1B;
                b[7] = 0x00;
            }
            srcMac = Buffer.from(b).reverse().toString('hex').toUpperCase().match(/.{1,2}/g).join(':');
        } else if (srcExtBytes.length === 8) {
            srcMac = Buffer.from(srcExtBytes).reverse().toString('hex').toUpperCase().match(/.{1,2}/g).join(':');
        }
    }

    // Detect IB vs VA tag
    const isDstIb = dstMac.includes(':31:55:') || dstMac.endsWith(':0E:82') || dstMac.endsWith(':00:1E');
    const isDstVa = dstMac.includes(':31:56:') || (destShort !== null && !isDstIb && destShort !== 0xFFFF);
    const isSrcIb = srcMac.includes(':31:55:') || srcMac.endsWith(':0E:82') || srcMac.endsWith(':00:1E');
    const isSrcVa = srcMac.includes(':31:56:') || (srcShort !== null && !isSrcIb);

    let dstTag = '';
    if (isDstIb) dstTag = ' (IB)';
    else if (isDstVa) dstTag = ' (VA)';

    let srcTag = '';
    if (isSrcIb) srcTag = ' (IB)';
    else if (isSrcVa) srcTag = ' (VA)';

    return {
        dst: dstMac + dstTag,
        src: srcMac + srcTag,
        dstShort: dstShortStr || (destMode === 3 ? dstMac.split(':').slice(6).join('') : ''),
        srcShort: srcShortStr || (srcMode === 3 ? srcMac.split(':').slice(6).join('') : '')
    };
}

// Log message to file
function logToFile(msg) {
    if (!config.fileLogging) return;
    const time = new Date().toISOString();
    try {
        // Rotate log if it exceeds MAX_LOG_SIZE
        if (fs.existsSync(LIVE_LOG_PATH)) {
            const stats = fs.statSync(LIVE_LOG_PATH);
            if (stats.size > MAX_LOG_SIZE) {
                const rotated = LIVE_LOG_PATH + '.1';
                if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
                fs.renameSync(LIVE_LOG_PATH, rotated);
            }
        }
        fs.appendFileSync(LIVE_LOG_PATH, `[${time}] ${msg}\n`, 'utf-8');
    } catch (e) {
        console.error(`[logToFile ERROR] Failed writing to ${LIVE_LOG_PATH}: ${e.message}`);
    }
}

// Beautifully log parsed packets and publish to MQTT
function displayPacket(packet, type, meta = {}) {
    let pathStr = 'Unknown';
    if (type === 'unfragmented' || type === 'complete') {
        pathStr = packet.coap.options.filter(o => o.num === 11).map(o => o.value.toString('utf-8')).join('/') || 'Unknown';

        const isRequest = coapParser.isRequest(packet.coap.code);
        if (isRequest && pathStr !== 'Unknown') {
            cacheMidPath(packet.coap.mid, pathStr);
        } else {
            pathStr = getPathForMid(packet.coap.mid, pathStr);
        }

        const midKey = `${packet.macInfo.srcShort}:${packet.coap.mid}`;
        const now = Date.now();
        if (printedCoapPackets.has(midKey)) {
            const lastTime = printedCoapPackets.get(midKey);
            if (now - lastTime < 15000) { // 15-second CoAP transaction deduplication window
                statsDecodedCoapDuplicate++;
                return; // Quietly ignore duplicate CoAP logs
            }
        }
        printedCoapPackets.set(midKey, now);
        statsDecodedCoapUnique++;

        // Housekeeping: purge old entries to keep memory low
        if (printedCoapPackets.size > 200) {
            for (const [key, ts] of printedCoapPackets.entries()) {
                if (now - ts > 30000) {
                    printedCoapPackets.delete(key);
                }
            }
        }

        // Home Assistant Discovery & State handler
        if (mqttClient && mqttClient.connected) {
            try {
                const haDiscovery = require('./lib/ha-discovery');
                haDiscovery.handlePacket(packet, type, meta);
            } catch (err) {
                console.error(`[HA Discovery] Error handling packet: ${err.message}`);
            }
        }

        // Publish to MQTT
        if (mqttClient && mqttClient.connected && pathStr && pathStr !== 'Unknown') {
            const senderMac = packet.macInfo.src.split(' ')[0];
            const baseTopic = config.mqtt.topic || 'tado/sniffer';
            const topic = `${baseTopic}/${senderMac}/${pathStr}`;

            const tlvFriendly = {};
            if (packet.tlv && packet.tlv.items) {
                packet.tlv.items.forEach(item => {
                    tlvFriendly[item.name] = item.value;
                });
            }

            const payloadData = {
                coap: {
                    type: ['CON', 'NON', 'ACK', 'RST'][packet.coap.type],
                    code: coapParser.codeStr(packet.coap.code),
                    mid: packet.coap.mid,
                    token: packet.coap.token.toString('hex'),
                    options: packet.coap.options.map(o => ({ num: o.num, hex: o.value.toString('hex') })),
                    payload: packet.coap.payload.toString('hex')
                },
                tlv: tlvFriendly,
                tlvRaw: packet.tlv ? packet.tlv.fields : {},
                rawHex: meta.rawHex,
                rawCoapHex: meta.rawCoapHex
            };

            mqttClient.publish(topic, JSON.stringify(payloadData), { qos: 0 });
        }
    }

    if (!config.consoleLogging) {
        if (type === 'incomplete') {
            const f = packet.fragmentInfo;
            logToFile(`Fragment received: Tag=0x${f.tag.toString(16).toUpperCase()} Type=${f.fragType} Progress=${f.progress.percent}%`);
        } else {
            logToFile(`COAP: /${pathStr} MID=0x${packet.coap.mid.toString(16).toUpperCase()} Code=${coapParser.codeStr(packet.coap.code)} Key=${meta.keyName} RSSI=${meta.rssi}`);
        }
        return;
    }

    const time = new Date().toLocaleTimeString();
    const border = '================================================================================';
    console.log('\n' + border);

    let title = '';
    if (type === 'unfragmented') title = `[LIVE] 🟢 NEW UNFRAGMENTED COAP PACKET`;
    else if (type === 'complete') title = `[LIVE] 🔵 NEW FULLY REASSEMBLED COAP PACKET`;
    else if (type === 'incomplete') title = `[LIVE] 🟡 NEW INCOMPLETE FRAGMENT RECEIVED`;

    console.log(`${title} [${time}] [RSSI: ${meta.rssi} dBm]`);
    console.log(border);
    console.log(`*  Key Used:    ${meta.keyName}`);
    console.log(`*  Source MAC:  ${packet.macInfo.src} (Short: 0x${packet.macInfo.srcShort})`);
    console.log(`*  Dest MAC:    ${packet.macInfo.dst} (Short: 0x${packet.macInfo.dstShort})`);
    if (meta.rawHex) {
        console.log(`*  Raw Packet:  ${meta.rawHex}`);
    }

    if (type === 'incomplete') {
        const f = packet.fragmentInfo;
        console.log(`*  Fragment:    ${f.fragType} | Tag: 0x${f.tag.toString(16).toUpperCase()}`);
        console.log(`*  Progress:    Received ${f.progress.receivedBytes} / ${f.progress.totalSize} bytes (${f.progress.percent}%)`);
        console.log(`*  Missing:     ${f.missingParts}`);
        logToFile(`Fragment received: Tag=0x${f.tag.toString(16).toUpperCase()} Type=${f.fragType} Progress=${f.progress.percent}%`);
        return;
    }

    if (type === 'complete') {
        const r = packet.reassemblyInfo;
        console.log(`*  Reassembly:  Completed across ${r.partsCount} fragments (Tag: 0x${r.tag.toString(16).toUpperCase()})`);
    }

    console.log(`*  CoAP Details:`);
    console.log(`   - Type:      ${['CON', 'NON', 'ACK', 'RST'][packet.coap.type]}`);
    console.log(`   - Code:      ${coapParser.codeStr(packet.coap.code)}`);
    console.log(`   - MessageID: 0x${packet.coap.mid.toString(16).toUpperCase().padStart(4, '0')} (${packet.coap.mid})`);
    console.log(`   - URI Path:  /${pathStr}`);

    if (packet.tlv && packet.tlv.items && packet.tlv.items.length > 0) {
        console.log(`*  TLV Fields:`);
        packet.tlv.items.forEach(item => {
            const val = typeof item.value === 'object' ? JSON.stringify(item.value) : item.value;
            console.log(`   -> [${item.fid}] ${item.name}: ${val} (${item.type})`);
        });
    } else {
        console.log(`*  TLV Payload: None / Empty`);
    }

    console.log(border + '\n');

    // Save to live log
    logToFile(`COAP: /${pathStr} MID=0x${packet.coap.mid.toString(16).toUpperCase()} Code=${coapParser.codeStr(packet.coap.code)} Key=${meta.keyName} RSSI=${meta.rssi}`);
}

function processDecryptedPayload(payload, macInfo, innerProto, seq, type, meta, reassemblyInfo = null) {
    if (payload.length < 5) {
        statsNoCoap++;
        return;
    }
    const senderShort = payload.readUInt16LE(0);
    const mode = payload.readUInt16LE(2);
    const nhc = payload[4];

    const coapOffset = findCoapOffset(payload);
    if (coapOffset !== -1) {
        const coapBytes = payload.slice(coapOffset);
        const coap = coapParser.parse(coapBytes);
        if (coap.ok && coap.ver === 1) {
            if (coap.code === 0) {
                return; // Quietly ignore empty ACKs (Code 0.00)
            }
            statsDecodedCoap++;
            let decodedTlv = null;
            if (coap.payload && coap.payload.length > 0) {
                decodedTlv = tlvDecoder.decode(coap.payload);
            }

            const fullMeta = {
                ...meta,
                rawCoapHex: coapBytes.toString('hex')
            };

            const packet = {
                macInfo,
                innerProto,
                seq,
                senderShort,
                mode,
                nhc,
                coap,
                tlv: decodedTlv
            };
            if (reassemblyInfo) {
                packet.reassemblyInfo = reassemblyInfo;
            }

            displayPacket(packet, type, fullMeta);
        } else {
            statsNoCoap++;
        }
    } else {
        statsNoCoap++;
    }
}

async function start() {
    try {
        console.log('==================================================================');
        console.log(' tanoclo SNIFFER: RF DECRYPTER');
        console.log('==================================================================');

        console.log('[1/3] Loading TLV labels from JSON...');
        const labelsPath = path.join(__dirname, 'tlv_labels.json');
        let labels = { fields: {} };
        if (fs.existsSync(labelsPath)) {
            labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
            console.log(`      Success! Loaded ${Object.keys(labels.fields).length} field labels from JSON file.`);
        } else {
            console.warn(`[WARN] Static TLV label file ${labelsPath} not found. Run "node sync_tlv_labels.js" to generate it.`);
        }
        tlvDecoder.init(labels.fields);

        // Setup reassembler
        const reassembler = new SixLoWPANReassembler();
        globalReassembler = reassembler;

        console.log('[2/3] Setting up TCP receiver...');

        function handleIncomingPacket(data) {
            // Prevent processing duplicate packets within a 1-second sliding window
            const hexKey = data.hex;
            const now = Date.now();
            if (processedPackets.has(hexKey)) {
                const lastTime = processedPackets.get(hexKey);
                if (now - lastTime < 1000) {
                    statsDuplicateRaw++;
                    return; // Silently skip duplicate packet
                }
            }
            processedPackets.set(hexKey, now);

            // Clean up old entries from duplicate cache to keep memory consumption low
            if (processedPackets.size > 200) {
                for (const [key, ts] of processedPackets.entries()) {
                    if (now - ts > 5000) {
                        processedPackets.delete(key);
                    }
                }
            }

            const rawBytes = Buffer.from(data.hex, 'hex');
            const rssi = data.rssi;
            const crcOk = data.crc_ok;
            const pan = getPanId(rawBytes);
            if (pan !== null && excludedPanIds.has(pan)) {
                return; // Silently skip packets from auto-excluded PAN IDs
            }
            const panStr = pan !== null ? `0x${pan.toString(16).toUpperCase()}` : 'UNKNOWN';

            // Determine if this packet is from a whitelisted network.
            // If explicit PAN IDs were configured, require match; otherwise accept all PANs.
            const isWhitelisted = (!hasExplicitWhitelist || pan === null || whitelistedPanIds.has(pan));

            // Log raw packet to live log for whitelisted networks
            if (isWhitelisted) {
                logToFile(`RAW_PACKET: hex=${data.hex} rssi=${rssi}`);
            }

            let frame = null;
            let decrypted = null;
            let keyUsed = null;
            let recoveryInfo = null;

            // Extract IEEE 802.15.4 frame (byte 0 is length)
            const len = rawBytes[0];
            if (len >= 15 && len < rawBytes.length) {
                frame = rawBytes.subarray(1, 1 + len);
                // Quick check for security enabled Data frame signature
                if ((frame[0] & 0x0F) === 0x09) {
                    for (const key of KEYS) {
                        decrypted = decryptCCM(frame, key);
                        if (decrypted) {
                            keyUsed = key;
                            break;
                        }
                    }
                    if (!decrypted) {
                        statsDecryptionFailed++;
                        if (config.autoExclusion && pan !== null && !discoveredPanIds.has(pan)) {
                            excludedPanIds.add(pan);
                            if (config.consoleLogging) {
                                console.log(`[EXCLUDE] Auto-excluding PAN ID ${panStr} (failed decryption with all configured keys)`);
                            }
                        }
                        if (isWhitelisted) {
                            logToFile(`Decryption failed: signature=0x09, len=${len}, PAN=${panStr}`);
                        }
                        return;
                    }
                } else {
                    statsNotEncrypted++;
                    const frameType = frame[0] & 0x07;
                    const frameTypeName = frameType === 0 ? 'Beacon' : (frameType === 2 ? 'MAC ACK' : (frameType === 3 ? 'MAC Command' : `Type 0x${frameType.toString(16)}`));
                    if (isWhitelisted) {
                        logToFile(`Decryption ignored: ${frameTypeName}, len=${len}`);
                        if (config.consoleLogging) {
                            console.log(`[RAW MAC] ${frameTypeName} RSSI=${rssi} dBm (len=${len}). Raw: ${data.hex}`);
                        }
                    }
                    return;
                }
            } else {
                statsShortFrame++;
                if (isWhitelisted) {
                    logToFile(`Decryption ignored: short frame, len=${len}, rawLen=${rawBytes.length}`);
                    if (config.consoleLogging) {
                        console.log(`[RAW SHORT] RSSI=${rssi} dBm (len=${len}). Raw: ${data.hex}`);
                    }
                }
                return;
            }

            // Track discovered PAN ID if not already tracked
            if (pan !== null && !discoveredPanIds.has(pan)) {
                discoveredPanIds.add(pan);
                if (config.consoleLogging) {
                    console.log(`[NETWORK] Discovered active network PAN ID: 0x${pan.toString(16).toUpperCase()}`);
                }
            }

            const keyName = KEY_NAMES.get(keyUsed.toString('hex'));
            const macInfo = decodeMAC(frame, decrypted);
            const innerProto = decrypted[3];
            const seq = decrypted[4];

            const timestamp = new Date().toLocaleTimeString();

            // Feed to the 6LoWPAN Reassembler
            const result = reassembler.process(decrypted, timestamp);

            if (result.type === 'duplicate_fragment') {
                return; // Quietly ignore duplicate fragment for already completed datagram
            }

            if (result.type === 'unfragmented') {
                if (innerProto !== 0x04) {
                    statsNonOperational++;
                    // Non-operational frame, e.g. ICMPv6 (0x3B)
                    if (innerProto === 0x3B) {
                        const icmpType = decrypted[6];
                        const icmpCode = decrypted[7];
                        const icmpName = icmpType === 0x85 ? 'Router Solicitation' : (icmpType === 0x86 ? 'Router Advertisement' : 'Unknown');
                        if (config.consoleLogging) {
                            console.log(`\n[LIVE] 🟢 NEW ICMPv6 ${icmpName} BROADCAST (Inner Proto: 0x3B, Type: 0x${icmpType.toString(16).toUpperCase()}). Raw: ${data.hex}`);
                        }
                    }
                    return;
                }
                const tado_payload = decrypted.slice(5);
                processDecryptedPayload(tado_payload, macInfo, innerProto, seq, 'unfragmented', {
                    rssi,
                    keyName,
                    recovery: recoveryInfo,
                    rawHex: data.hex
                });
            } else if (result.type === 'incomplete') {
                statsIncompleteFragment++;
                const meta = {
                    rssi,
                    keyName,
                    recovery: recoveryInfo,
                    rawHex: data.hex
                };
                displayPacket({
                    macInfo,
                    fragmentInfo: {
                        fragType: result.fragType,
                        tag: result.tag,
                        size: result.size,
                        offset: result.offset,
                        length: result.length,
                        progress: result.progress,
                        missingParts: result.missingParts
                    }
                }, 'incomplete', meta);
            } else if (result.type === 'complete') {
                statsReassembledComplete++;
                const reassembled = result.data;
                if (innerProto !== 0x04) {
                    statsNonOperational++;
                    return;
                }
                processDecryptedPayload(reassembled, macInfo, innerProto, seq, 'complete', {
                    rssi,
                    keyName,
                    recovery: recoveryInfo,
                    rawHex: data.hex
                }, {
                    tag: result.tag,
                    size: result.size,
                    partsCount: result.dgInfo.lines.length,
                    fragmentLines: result.dgInfo.lines
                });
            }
        }

        // Setup TCP server listening on port
        const net = require('net');
        tcpServer = net.createServer((socket) => {
            if (config.consoleLogging) {
                console.log(`[TCP] Client connected: ${socket.remoteAddress}:${socket.remotePort}`);
            }
            activeSockets.add(socket);

            let chunks = [];
            let totalLength = 0;

            socket.on('data', (chunk) => {
                chunks.push(chunk);
                totalLength += chunk.length;

                if (totalLength < 2) return;

                let clientBuffer = Buffer.concat(chunks, totalLength);

                while (true) {
                    if (clientBuffer.length < 2) {
                        break; // Need at least magic and length byte
                    }

                    // Find the next 0x5A magic byte
                    if (clientBuffer[0] !== 0x5A) {
                        const index = clientBuffer.indexOf(0x5A);
                        if (index === -1) {
                            clientBuffer = Buffer.alloc(0);
                            break;
                        } else {
                            clientBuffer = clientBuffer.slice(index);
                            continue;
                        }
                    }

                    const payloadLen = clientBuffer[1];
                    const frameLen = 2 + payloadLen;

                    if (clientBuffer.length < frameLen) {
                        break; // Need more data for the full frame
                    }

                    // Extract the payload
                    const frame = clientBuffer.slice(2, frameLen);
                    // Slice the client buffer for the next iteration
                    clientBuffer = clientBuffer.slice(frameLen);

                    // Parse the frame
                    statsTcpReceived++; // Count as received packet
                    if (frame.length < 3) {
                        statsTooShort++;
                        continue;
                    }

                    const rssi = frame.readInt8(0);
                    const crc_ok = frame.readUInt8(1) !== 0;
                    const len = frame.readUInt8(2);
                    const hex = frame.slice(2, 3 + len).toString('hex');

                    if (!crc_ok) {
                        statsCrcFailed++;
                        continue;
                    }

                    handleIncomingPacket({ hex, rssi, crc_ok });
                }

                chunks = [clientBuffer];
                totalLength = clientBuffer.length;
            });

            const removeSocket = () => {
                activeSockets.delete(socket);
            };

            socket.on('end', () => {
                if (config.consoleLogging) {
                    console.log(`[TCP] Client disconnected`);
                }
                removeSocket();
            });

            socket.on('error', (err) => {
                console.error(`[TCP] Socket error: ${err.message}`);
                removeSocket();
            });

            socket.on('close', removeSocket);
        });

        tcpServer.on('error', (err) => {
            console.error(`[TCP] Server error: ${err.message}`);
        });

        tcpServer.listen(config.tcpPort, config.tcpHost, () => {
            console.log(`[3/3] TCP server listening on ${config.tcpHost}:${config.tcpPort}`);
            if (config.fileLogging) {
                console.log(`[File Logging] Active. Target log path: ${LIVE_LOG_PATH}`);
                logToFile('=== TaNoClo Sniffer Stream Receiver Started ===');
            } else {
                console.log('[File Logging] Disabled (file_logging=false in configuration)');
            }
        });

        // Periodic diagnostic output to correlate with ESP32 sniffer stats
        if (PRINT_STATS) {
            let lastTcpReceived = 0;
            const statsInterval = setInterval(() => {
                const currentTcp = statsTcpReceived;
                const diff = currentTcp - lastTcpReceived;
                const ratePerSec = (diff / 60).toFixed(2);
                lastTcpReceived = currentTcp;

                const sumHandled = statsTooShort + statsCrcFailed + statsDuplicateRaw + statsShortFrame +
                    statsNotEncrypted + statsDecryptionFailed + statsNonOperational +
                    statsNoCoap + statsIncompleteFragment + statsDecodedCoap;
                const matches = (sumHandled === currentTcp);

                console.log('==================================================================');
                console.log('=== Tado Sniffer Diagnostic Stats (Every 60s) ===');
                console.log(`  * Total TCP Packets Received:   ${currentTcp} (${ratePerSec} pkts/s)`);
                console.log('  * Message Handling Breakdown:');
                console.log(`    - Ignored (Length < 3):       ${statsTooShort}`);
                console.log(`    - Bad CRC:                    ${statsCrcFailed}`);
                console.log(`    - Duplicate Raw Packets:      ${statsDuplicateRaw}`);
                console.log(`    - Short IEEE 802.15.4 Frames: ${statsShortFrame}`);
                console.log(`    - Unencrypted/Control Frames: ${statsNotEncrypted}`);
                console.log(`    - Decryption Failures:        ${statsDecryptionFailed}`);
                console.log(`    - Non-Operational Protocol:   ${statsNonOperational}`);
                console.log(`    - Operational but No CoAP:    ${statsNoCoap}`);
                console.log(`    - Incomplete 6LoWPAN Frags:   ${statsIncompleteFragment}`);
                console.log(`    - Successfully Decoded CoAP:  ${statsDecodedCoap}`);
                console.log(`      └─ Unique Transactions:     ${statsDecodedCoapUnique}`);
                console.log(`      └─ Duplicate Retransmissions:${statsDecodedCoapDuplicate}`);
                console.log(`  * Sum of Handled Categories:    ${sumHandled} (${matches ? 'VALIDATED ✓' : 'ERROR ✗'})`);
                console.log(`  * Active Whitelisted PANs:      ${whitelistedPanIds.size}`);
                console.log(`  * Auto-Excluded PANs:           ${excludedPanIds.size}`);
                console.log(`  * Reassembled Complete count:   ${statsReassembledComplete}`);
                console.log('==================================================================');
            }, 60000);
            statsInterval.unref();
        }
    } catch (err) {
        console.error('Fatal Error:', err.message);
        process.exit(1);
    }
}

start();

// Periodic cache cleanup (every 30s) to bound memory
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of processedPackets.entries()) {
        if (now - ts > 5000) processedPackets.delete(key);
    }
    for (const [key, ts] of printedCoapPackets.entries()) {
        if (now - ts > 10000) printedCoapPackets.delete(key);
    }
    if (globalReassembler) {
        globalReassembler.cleanup();
    }

    if (mqttClient && mqttClient.connected) {
        try {
            haDiscovery.publishReceiverStats({
                statsTcpReceived,
                statsCrcFailed,
                statsDuplicateRaw,
                statsDecryptionFailed,
                statsDecodedCoap,
                whitelistedPanIdsSize: whitelistedPanIds.size
            });
        } catch (err) {
            // ignore
        }
    }
}, 30000);
cleanupInterval.unref();

// Graceful shutdown handler
function shutdown(signal) {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    if (mqttClient) {
        try { mqttClient.end(true); } catch (e) { /* ignore */ }
    }
    if (tcpServer) {
        try {
            tcpServer.close(() => {
                if (config.consoleLogging) {
                    console.log('[TCP] Server closed successfully');
                }
            });
        } catch (e) { /* ignore */ }
    }
    for (const socket of activeSockets) {
        try { socket.destroy(); } catch (e) { /* ignore */ }
    }
    activeSockets.clear();
    logToFile(`Sniffer receiver stopped (${signal})`);
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

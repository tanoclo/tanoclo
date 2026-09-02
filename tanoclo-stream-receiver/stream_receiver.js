/**
 * @file stream_receiver.js
 * @brief Main sniffer server listening for raw RF packet streams over TCP.
 * 
 * Ingests IEEE 802.15.4 frames, runs AES-128-CCM multi-key decryption,
 * performs 6LoWPAN fragmentation reassembly, decodes CoAP/TLV packets,
 * updates passive device state caches, and broadcasts to MQTT / Home Assistant.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');

const rfCrypto = require('./lib/rf-crypto');
const SixLoWPANReassembler = require('./lib/reassembler');
const coapParser = require('./lib/coap');
const tlvDecoder = require('./lib/tlv');
const deviceRegistry = require('./lib/device-registry');
const haDiscovery = require('./lib/ha-discovery');
const mqttPublisher = require('./lib/mqtt-publisher');
const messageProcessor = require('./lib/message-processor');
const csl = require('./lib/csl');
const icmpv6 = require('./lib/icmpv6');

// Global state variables
let tcpServer = null;
const activeSockets = new Set();
let globalReassembler = null;

// Configuration Defaults
const config = {
    tcpPort: 9999,
    tcpHost: "0.0.0.0",
    fileLogging: true,
    maxLogSizeMb: 5,
    maxRotatedLogs: 1,
    consoleLogging: true,
    autoExclusion: true,
    keys: {
        "PAIRING": rfCrypto.PAIRING_KEY_HEX
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

// 1. Load configuration from config.json if present
const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
    try {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (fileConfig.tcpPort !== undefined) config.tcpPort = fileConfig.tcpPort;
        if (fileConfig.fileLogging !== undefined) config.fileLogging = fileConfig.fileLogging;
        if (fileConfig.maxLogSizeMb !== undefined) config.maxLogSizeMb = Number(fileConfig.maxLogSizeMb);
        if (fileConfig.max_log_size_mb !== undefined) config.maxLogSizeMb = Number(fileConfig.max_log_size_mb);
        if (fileConfig.maxLogSize !== undefined) {
            const sz = Number(fileConfig.maxLogSize);
            config.maxLogSizeMb = sz > 1024 ? sz / (1024 * 1024) : sz;
        }
        if (fileConfig.max_log_size !== undefined) {
            const sz = Number(fileConfig.max_log_size);
            config.maxLogSizeMb = sz > 1024 ? sz / (1024 * 1024) : sz;
        }
        if (fileConfig.maxRotatedLogs !== undefined) config.maxRotatedLogs = parseInt(fileConfig.maxRotatedLogs, 10);
        if (fileConfig.max_rotated_logs !== undefined) config.maxRotatedLogs = parseInt(fileConfig.max_rotated_logs, 10);
        if (fileConfig.consoleLogging !== undefined) config.consoleLogging = fileConfig.consoleLogging;
        if (fileConfig.autoExclusion !== undefined) config.autoExclusion = !!fileConfig.autoExclusion;
        if (fileConfig.auto_exclusion !== undefined) config.autoExclusion = !!fileConfig.auto_exclusion;
        if (fileConfig.tcpHost !== undefined) config.tcpHost = fileConfig.tcpHost;
        if (fileConfig.bindAddress !== undefined) config.tcpHost = fileConfig.bindAddress;
        if (fileConfig.keys) Object.assign(config.keys, fileConfig.keys);
        if (fileConfig.whitelistedPanIds) config.whitelistedPanIds = fileConfig.whitelistedPanIds;
        if (fileConfig.mqtt) Object.assign(config.mqtt, fileConfig.mqtt);
    } catch (err) {
        console.error(`[Config] Error parsing config.json: ${err.message}`);
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
if (process.env.MAX_LOG_SIZE_MB !== undefined) {
    const mb = parseFloat(process.env.MAX_LOG_SIZE_MB);
    if (!isNaN(mb) && mb > 0) config.maxLogSizeMb = mb;
} else if (process.env.MAX_LOG_SIZE !== undefined) {
    const sz = parseFloat(process.env.MAX_LOG_SIZE);
    if (!isNaN(sz) && sz > 0) config.maxLogSizeMb = sz > 1024 ? sz / (1024 * 1024) : sz;
}
if (process.env.MAX_ROTATED_LOGS !== undefined) {
    const val = parseInt(process.env.MAX_ROTATED_LOGS, 10);
    if (!isNaN(val) && val >= 0) config.maxRotatedLogs = val;
}
if (process.env.CONSOLE_LOGGING !== undefined) config.consoleLogging = process.env.CONSOLE_LOGGING === 'true';
if (process.env.AUTO_EXCLUSION !== undefined) config.autoExclusion = process.env.AUTO_EXCLUSION === 'true' || process.env.AUTO_EXCLUSION === '1';

// 3. Load from Command Line Arguments
const args = process.argv;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) config.tcpPort = parseInt(args[i + 1], 10);
    else if (args[i] === '--host' && args[i + 1]) config.tcpHost = args[i + 1];
    else if (args[i] === '--keys' && args[i + 1]) {
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
    } else if (args[i] === '--mqtt-topic' && args[i + 1]) config.mqtt.topic = args[i + 1];
    else if (args[i] === '--mqtt-user' && args[i + 1]) config.mqtt.username = args[i + 1];
    else if (args[i] === '--mqtt-pass' && args[i + 1]) config.mqtt.password = args[i + 1];
    else if (args[i] === '--max-log-size' && args[i + 1]) {
        const sz = parseFloat(args[i + 1]);
        if (!isNaN(sz) && sz > 0) config.maxLogSizeMb = sz > 1024 ? sz / (1024 * 1024) : sz;
    } else if (args[i] === '--max-rotated-logs' && args[i + 1]) {
        const val = parseInt(args[i + 1], 10);
        if (!isNaN(val) && val >= 0) config.maxRotatedLogs = val;
    } else if (args[i] === '--auto-exclusion' && args[i + 1]) {
        config.autoExclusion = args[i + 1] === 'true' || args[i + 1] === '1';
    } else if (args[i] === '--no-auto-exclusion') config.autoExclusion = false;
    else if (args[i] === '--no-file-logging') config.fileLogging = false;
    else if (args[i] === '--file-logging') config.fileLogging = true;
    else if (args[i] === '--no-console-logging') config.consoleLogging = false;
    else if (args[i] === '--console-logging') config.consoleLogging = true;
}

// Prepare encryption keys
const KEYS = [];
const KEY_NAMES = new Map();
for (const [name, hexKey] of Object.entries(config.keys)) {
    const cleanHex = hexKey.replace(/\s+/g, '');
    if (cleanHex.length === 32) {
        const keyBuf = Buffer.from(cleanHex, 'hex');
        KEYS.push(keyBuf);
        KEY_NAMES.set(cleanHex.toLowerCase(), name);
    }
}
// Always ensure pairing key is present
if (!KEY_NAMES.has(rfCrypto.PAIRING_KEY_HEX.toLowerCase())) {
    const pairBuf = Buffer.from(rfCrypto.PAIRING_KEY_HEX, 'hex');
    KEYS.push(pairBuf);
    KEY_NAMES.set(rfCrypto.PAIRING_KEY_HEX.toLowerCase(), 'PAIRING');
}

// Log directory resolution
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

// Whitelisted PAN IDs
const explicitPanSet = new Set(
    config.whitelistedPanIds.map(id => typeof id === 'string' && id.startsWith('0x') ? parseInt(id, 16) : Number(id))
);
const hasExplicitWhitelist = explicitPanSet.size > 0;
const whitelistedPanIds = explicitPanSet;
const discoveredPanIds = new Set();
const excludedPanIds = new Set();

const PRINT_STATS = process.argv.includes('--stats');

// Statistical tracking counters
let statsTcpReceived = 0;
let statsTooShort = 0;
let statsCrcFailed = 0;
let statsDuplicateRaw = 0;
let statsShortFrame = 0;
let statsNotEncrypted = 0;
let statsDecryptionFailed = 0;
let statsNonOperational = 0;
let statsNoCoap = 0;
let statsIncompleteFragment = 0;
let statsDecodedCoap = 0;
let statsDecodedCoapUnique = 0;
let statsDecodedCoapDuplicate = 0;
let statsReassembledComplete = 0;
let statsCslBeacons = 0;
let statsMacCoordination = 0;
let statsIcmpv6EchoReq = 0;
let statsIcmpv6EchoRep = 0;
let statsIcmpv6NeighborSol = 0;
let statsIcmpv6NeighborAdv = 0;
let statsIcmpv6RouterSolAdv = 0;
let statsIcmpv6Other = 0;

// Duplicate raw packet sliding window
const processedPackets = new Map();

function logToFile(msg) {
    if (!config.fileLogging) return;
    const time = new Date().toISOString();
    try {
        const maxLogBytes = Math.round((config.maxLogSizeMb || 5) * 1024 * 1024);
        const maxRotatedLogs = config.maxRotatedLogs !== undefined ? config.maxRotatedLogs : 1;
        if (fs.existsSync(LIVE_LOG_PATH)) {
            const stats = fs.statSync(LIVE_LOG_PATH);
            if (stats.size > maxLogBytes) {
                if (maxRotatedLogs <= 0) {
                    fs.unlinkSync(LIVE_LOG_PATH);
                } else {
                    const oldest = `${LIVE_LOG_PATH}.${maxRotatedLogs}`;
                    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
                    for (let i = maxRotatedLogs - 1; i >= 1; i--) {
                        const current = `${LIVE_LOG_PATH}.${i}`;
                        const next = `${LIVE_LOG_PATH}.${i + 1}`;
                        if (fs.existsSync(current)) {
                            fs.renameSync(current, next);
                        }
                    }
                    fs.renameSync(LIVE_LOG_PATH, `${LIVE_LOG_PATH}.1`);
                }
            }
        }
        fs.appendFileSync(LIVE_LOG_PATH, `[${time}] ${msg}\n`, 'utf-8');
    } catch (e) {
        console.error(`[logToFile ERROR] Failed writing to ${LIVE_LOG_PATH}: ${e.message}`);
    }
}

function displayPacket(packet, type, meta = {}) {
    if (type === 'incomplete') {
        const f = packet.fragmentInfo;
        if (!config.consoleLogging) {
            logToFile(`Fragment received: Tag=0x${f.tag.toString(16).toUpperCase()} Type=${f.fragType} Progress=${f.progress.percent}%`);
            return;
        }

        const time = new Date().toLocaleTimeString();
        const border = '================================================================================';
        console.log('\n' + border);
        console.log(`[LIVE] 🟡 NEW INCOMPLETE FRAGMENT RECEIVED [${time}] [RSSI: ${meta.rssi} dBm]`);
        console.log(border);
        console.log(`*  Key Used:    ${meta.keyName}`);
        console.log(`*  Source MAC:  ${packet.macInfo.src} (Short: 0x${packet.macInfo.srcShort})`);
        console.log(`*  Dest MAC:    ${packet.macInfo.dst} (Short: 0x${packet.macInfo.dstShort})`);
        if (meta.rawHex) {
            console.log(`*  Raw Packet:  ${meta.rawHex}`);
        }
        console.log(`*  Fragment:    ${f.fragType} | Tag: 0x${f.tag.toString(16).toUpperCase()}`);
        console.log(`*  Progress:    Received ${f.progress.receivedBytes} / ${f.progress.totalBytes || f.progress.totalSize} bytes (${f.progress.percent}%)`);
        console.log(`*  Missing:     ${f.missingParts}`);
        console.log(border + '\n');
        logToFile(`Fragment received: Tag=0x${f.tag.toString(16).toUpperCase()} Type=${f.fragType} Progress=${f.progress.percent}%`);
        return;
    }

    if (!packet || !packet.coap) return;

    const result = messageProcessor.processCoapPacket(packet, type, meta);
    if (result.isDuplicate) {
        statsDecodedCoapDuplicate++;
        return;
    }
    statsDecodedCoapUnique++;

    const pathStr = result.pathStr || 'Unknown';

    if (!config.consoleLogging) {
        logToFile(`COAP: /${pathStr} MID=0x${packet.coap.mid.toString(16).toUpperCase()} Code=${coapParser.codeStr(packet.coap.code)} Key=${meta.keyName} RSSI=${meta.rssi}`);
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
    logToFile(`COAP: /${pathStr} MID=0x${packet.coap.mid.toString(16).toUpperCase()} Code=${coapParser.codeStr(packet.coap.code)} Key=${meta.keyName} RSSI=${meta.rssi}`);
}

function processDecryptedPayload(payload, macInfo, innerProto, seq, type, meta, reassemblyInfo = null) {
    if (!payload || payload.length < 4) {
        statsNoCoap++;
        return;
    }

    const coapOffset = coapParser.findCoapOffset(payload);
    if (coapOffset !== -1) {
        const coapBytes = payload.subarray(coapOffset);
        const coap = coapParser.parse(coapBytes);
        if (coap.ok && coap.ver === 1) {
            if (coap.code === 0) {
                statsDecodedCoap++;
                logToFile(`COAP_EMPTY_ACK: MID=0x${coap.mid.toString(16).toUpperCase()} Key=${meta.keyName} RSSI=${meta.rssi}`);
                if (config.consoleLogging) {
                    console.log(`[COAP ACK] 📭 Empty ACK MID=0x${coap.mid.toString(16).toUpperCase()} From=${macInfo.src} To=${macInfo.dst} RSSI=${meta.rssi} dBm`);
                }
                return;
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
                coap,
                tlv: decodedTlv
            };
            if (reassemblyInfo) {
                packet.reassemblyInfo = reassemblyInfo;
            }

            displayPacket(packet, type, fullMeta);
            return;
        }
    }

    // Check for ICMPv6 packets deterministically via RFC 6282 IPHC parser
    const icmpTarget = meta.decryptedRaw || payload;
    const icmp = icmpv6.parseICMPv6(icmpTarget);
    if (icmp) {
        if (icmp.type === icmpv6.ICMPv6Type.ECHO_REQUEST) statsIcmpv6EchoReq++;
        else if (icmp.type === icmpv6.ICMPv6Type.ECHO_REPLY) statsIcmpv6EchoRep++;
        else if (icmp.type === icmpv6.ICMPv6Type.NEIGHBOR_SOLICITATION) statsIcmpv6NeighborSol++;
        else if (icmp.type === icmpv6.ICMPv6Type.NEIGHBOR_ADVERTISEMENT) statsIcmpv6NeighborAdv++;
        else if (icmp.type === icmpv6.ICMPv6Type.ROUTER_SOLICITATION || icmp.type === icmpv6.ICMPv6Type.ROUTER_ADVERTISEMENT) statsIcmpv6RouterSolAdv++;
        else statsIcmpv6Other++;

        logToFile(`ICMPv6: ${icmp.typeName} (Type=${icmp.type}) From=${macInfo.src} To=${macInfo.dst} RSSI=${meta.rssi}`);
        if (config.consoleLogging) {
            console.log(`[ICMPv6] 🌐 ${icmp.typeName} (Type=0x${icmp.type.toString(16).toUpperCase()}) From=${macInfo.src} To=${macInfo.dst} RSSI=${meta.rssi} dBm`);
        }
        return;
    }

    statsNoCoap++;
    logToFile(`Decryption ignored: No CoAP, len=${payload.length}`);
}

async function start() {
    try {
        console.log('==================================================================');
        console.log(' TaNoClo SNIFFER: RF DECRYPTER & STREAM RECEIVER');
        console.log('==================================================================');

        // [1/4] Initialize TLV labels
        console.log('[1/4] Loading TLV labels from JSON...');
        const labelsPath = path.join(__dirname, 'tlv_labels.json');
        let labels = { fields: {} };
        if (fs.existsSync(labelsPath)) {
            labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
            console.log(`      Success! Loaded ${Object.keys(labels.fields).length} field labels from JSON file.`);
        } else {
            console.warn(`[WARN] Static TLV label file ${labelsPath} not found. Run "node sync_tlv_labels.js" to generate it.`);
        }
        tlvDecoder.init(labels.fields);

        // [2/4] Initialize Device Registry & HA Discovery
        console.log('[2/4] Initializing Device Registry & MQTT Auto-Discovery...');
        deviceRegistry.init();
        haDiscovery.init(config);

        // [3/4] Initialize MQTT Publisher
        if (config.mqtt && config.mqtt.enabled) {
            const client = mqttPublisher.init(config);
            if (client) {
                client.on('connect', () => {
                    haDiscovery.publishReceiverDiscovery();
                    mqttPublisher.publishReceiverStats({
                        statsTcpReceived,
                        statsCrcFailed,
                        statsDuplicateRaw,
                        statsDecryptionFailed,
                        statsDecodedCoap,
                        whitelistedPanIdsSize: whitelistedPanIds.size
                    });
                });
            }
        } else {
            console.log('[MQTT] MQTT publishing disabled in configuration.');
        }

        // [4/4] Setup TCP server
        const reassembler = new SixLoWPANReassembler();
        globalReassembler = reassembler;

        console.log('[4/4] Setting up TCP receiver pipeline...');

        function handleIncomingPacket(data) {
            const hexKey = data.hex;
            const now = Date.now();
            if (processedPackets.has(hexKey)) {
                const lastTime = processedPackets.get(hexKey);
                if (now - lastTime < 1000) {
                    statsDuplicateRaw++;
                    return;
                }
            }
            processedPackets.set(hexKey, now);

            if (processedPackets.size > 300) {
                for (const [k, ts] of processedPackets.entries()) {
                    if (now - ts > 5000) processedPackets.delete(k);
                }
            }

            const rawBytes = Buffer.from(data.hex, 'hex');
            const rssi = data.rssi;
            const pan = rfCrypto.getPanId(rawBytes);

            if (pan !== null && excludedPanIds.has(pan)) {
                return;
            }
            const panStr = pan !== null ? `0x${pan.toString(16).toUpperCase()}` : 'UNKNOWN';
            const isWhitelisted = (!hasExplicitWhitelist || pan === null || whitelistedPanIds.has(pan));

            if (isWhitelisted) {
                logToFile(`RAW_PACKET: hex=${data.hex} rssi=${rssi}`);
            }

            let frame = null;
            let decrypted = null;
            let keyUsed = null;

            const len = rawBytes[0];
            if (len >= 10 && len < rawBytes.length) {
                frame = rawBytes.subarray(1, 1 + len);
                if ((frame[0] & 0x0F) === 0x09) {
                    for (const key of KEYS) {
                        decrypted = rfCrypto.decryptCCM(frame, key);
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
                    // Check for IEEE 802.15.4e CSL Multipurpose wake-up beacons (0x25 FCF)
                    if (csl.isCSLBeacon(frame)) {
                        const beacon = csl.parseCSLBeacon(frame);
                        if (beacon) {
                            statsCslBeacons++;
                            if (isWhitelisted) {
                                logToFile(`CSL_BEACON: PAN=0x${beacon.panId.toString(16)} Dst=${beacon.dstShort} Countdown=${beacon.countdown} RSSI=${rssi}`);
                                if (config.consoleLogging) {
                                    console.log(`[CSL BEACON] 📡 PAN=0x${beacon.panId.toString(16).toUpperCase()} Dst=${beacon.dstShort} Countdown=${beacon.countdown} Phase=${beacon.phase} RSSI=${rssi} dBm`);
                                }
                            }
                            return;
                        }
                    }

                    // Check for Extended MAC / CSL Coordination frames (0xEE42 / 0x6E42)
                    if (csl.isMACCoordinationFrame(frame)) {
                        const coord = csl.parseMACCoordinationFrame(frame);
                        if (coord) {
                            statsMacCoordination++;
                            if (isWhitelisted) {
                                logToFile(`MAC_COORD: PAN=0x${coord.panId.toString(16)} From=${coord.srcMac} To=${coord.dstMac} RSSI=${rssi}`);
                                if (config.consoleLogging) {
                                    console.log(`[MAC COORD] 🔄 PAN=0x${coord.panId.toString(16).toUpperCase()} From=${coord.srcMac} To=${coord.dstMac} RSSI=${rssi} dBm`);
                                }
                            }
                            return;
                        }
                    }

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

            if (pan !== null && !discoveredPanIds.has(pan)) {
                discoveredPanIds.add(pan);
                if (config.consoleLogging) {
                    console.log(`[NETWORK] Discovered active network PAN ID: 0x${pan.toString(16).toUpperCase()}`);
                }
            }

            const keyName = KEY_NAMES.get(keyUsed.toString('hex').toLowerCase()) || 'UNKNOWN_KEY';
            const macInfo = rfCrypto.decodeMAC(frame, decrypted);
            const innerProto = decrypted[3];
            const seq = decrypted[4];
            const timestamp = new Date().toLocaleTimeString();

            // Feed to 6LoWPAN Reassembler
            const result = reassembler.process(decrypted, timestamp);

            if (result.type === 'duplicate_fragment') {
                return;
            }

            if (result.type === 'unfragmented') {
                const tado_payload = decrypted.subarray(innerProto === 0x04 ? 5 : 0);
                processDecryptedPayload(tado_payload, macInfo, innerProto, seq, 'unfragmented', {
                    rssi,
                    keyName,
                    rawHex: data.hex,
                    decryptedRaw: decrypted
                });
            } else if (result.type === 'incomplete') {
                statsIncompleteFragment++;
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
                }, 'incomplete', {
                    rssi,
                    keyName,
                    rawHex: data.hex
                });
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
                    rawHex: data.hex,
                    decryptedRaw: decrypted
                }, {
                    tag: result.tag,
                    size: result.size,
                    partsCount: result.dgInfo.lines.length,
                    fragmentLines: result.dgInfo.lines
                });
            }
        }

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
                    if (clientBuffer.length < 2) break;

                    if (clientBuffer[0] !== 0x5A) {
                        const index = clientBuffer.indexOf(0x5A);
                        if (index === -1) {
                            clientBuffer = Buffer.alloc(0);
                            break;
                        } else {
                            clientBuffer = clientBuffer.subarray(index);
                            continue;
                        }
                    }

                    const payloadLen = clientBuffer[1];
                    const frameLen = 2 + payloadLen;

                    if (clientBuffer.length < frameLen) break;

                    const frame = clientBuffer.subarray(2, frameLen);
                    clientBuffer = clientBuffer.subarray(frameLen);

                    statsTcpReceived++;
                    if (frame.length < 3) {
                        statsTooShort++;
                        continue;
                    }

                    const rssi = frame.readInt8(0);
                    const crc_ok = frame.readUInt8(1) !== 0;
                    const len = frame.readUInt8(2);
                    const hex = frame.subarray(2, 3 + len).toString('hex');

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
                if (config.consoleLogging) console.log(`[TCP] Client disconnected`);
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
            console.log(`[Server] TCP server listening on ${config.tcpHost}:${config.tcpPort}`);
            if (config.fileLogging) {
                console.log(`[File Logging] Active. Log file: ${LIVE_LOG_PATH}`);
                logToFile('=== TaNoClo Sniffer Stream Receiver Started ===');
            }
        });

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
                console.log('=== TaNoClo Sniffer Diagnostic Stats (Every 60s) ===');
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

// Periodic cache cleanup and stats broadcast (every 30s)
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of processedPackets.entries()) {
        if (now - ts > 5000) processedPackets.delete(key);
    }
    if (globalReassembler) {
        globalReassembler.cleanup();
    }
    deviceRegistry.saveCache();

    mqttPublisher.publishReceiverStats({
        statsTcpReceived,
        statsCrcFailed,
        statsDuplicateRaw,
        statsDecryptionFailed,
        statsDecodedCoap,
        whitelistedPanIdsSize: whitelistedPanIds.size
    });
}, 30000);
cleanupInterval.unref();

// Graceful shutdown handler
function shutdown(signal) {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    deviceRegistry.saveCache();
    mqttPublisher.close();
    if (tcpServer) {
        try {
            tcpServer.close(() => {
                if (config.consoleLogging) console.log('[TCP] Server closed successfully');
            });
        } catch (e) { }
    }
    for (const socket of activeSockets) {
        try { socket.destroy(); } catch (e) { }
    }
    activeSockets.clear();
    logToFile(`Sniffer receiver stopped (${signal})`);
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

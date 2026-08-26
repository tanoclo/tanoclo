/**
 * @file lib/db-base.js
 * @brief Base database execution wrappers.
 */

'use strict';

/**
 * @module db-base
 * 
 * Core database abstraction layer for the TaNoClo server.
 * Handles MySQL connection pooling and provides high-level methods 
 * for interacting with the TaNoClo schema.
 */

const mysql = require('mysql2/promise');
const config = require('./config');
const crypto = require('crypto');
const { getLogger } = require('./logger');
const _log = getLogger('db');

const ORIENTATION_MAP = {
    0: 'HORIZONTAL',
    1: 'VERTICAL'
};

const MOUNT_STATE_MAP = {
    0: 'CALIBRATING',
    1: 'CALIBRATED',
    2: 'MOUNTED'
};

function mapOrientation(val) {
    if (val === undefined || val === null) return val;
    const s = String(val).toUpperCase().trim();
    if (s === 'HORIZONTAL' || s === '0' || s === '00') return 'HORIZONTAL';
    if (s === 'VERTICAL' || s === '1' || s === '01') return 'VERTICAL';
    return s;
}

function unmapOrientation(str) {
    if (typeof str === 'number') return str;
    if (!str) return 1; // Default to VERTICAL/1
    const s = String(str).toUpperCase().trim();
    if (s === 'HORIZONTAL' || s === '0' || s === '00') return 0;
    if (s === 'VERTICAL' || s === '1' || s === '01') return 1;
    return !isNaN(parseInt(str, 10)) ? parseInt(str, 10) : 1;
}

function mapMountState(val) {
    if (val === undefined || val === null) return val;
    return MOUNT_STATE_MAP[val] || String(val);
}

/**
 * Generate a deterministic 16-byte ETag for CoAP cache validation based on payload.
 * Fallbacks to random if no payload is provided.
 * @param {Buffer|string} payloadBuffer Optional payload to hash
 * @returns {Buffer} 16-byte ETag buffer
 */
function generateEtag(payloadBuffer = null) {
    if (payloadBuffer) {
        return crypto.createHash('md5').update(payloadBuffer).digest();
    }
    return crypto.randomBytes(16);
}

/**
 * Hash an OAuth token for secure storage.
 * Tokens are stored as SHA-256 hashes so DB compromise doesn't leak session tokens.
 * @param {string} token - Raw token string
 * @returns {string} Hex-encoded SHA-256 hash
 */
function hashToken(token) {
    if (!token) return token;
    return crypto.createHash('sha256').update(token).digest('hex');
}


/**
 * Port of Tado VA firmware hashing function (0x1750c)
 * Used for FID 0x015a (ETag) generation.
 */
function tadoHashStep(dataByte, currentHash) {
    let r0 = (dataByte ^ currentHash) & 0xffff;
    r0 = ((r0 & 0xff) << 8) | ((r0 >> 8) & 0xff); // Swap bytes
    let r3 = (r0 << 4) & 0xffff;
    r3 = (r3 & 0xf000) ^ r0;
    r3 = (r3 ^ (r3 >>> 12)) & 0xffff;
    let finalR0 = ((r3 >> 5) & 0x07f8) ^ r3;
    return finalR0 & 0xffff;
}

/**
 * Robust helper to lookup field value by hex key, friendly label name, or standard field prefix.
 */
function getFieldVal(fields, fid) {
    const hexKey = '0x' + fid.toString(16).toLowerCase().padStart(4, '0');
    if (fields[hexKey] !== undefined) return fields[hexKey];

    const tlv = require('./tlv');
    const label = tlv.getLabel(fid);
    if (label && label.name && fields[label.name] !== undefined) {
        return fields[label.name];
    }

    const fieldKey = 'field_' + fid.toString(16).toLowerCase().padStart(4, '0');
    if (fields[fieldKey] !== undefined) return fields[fieldKey];

    return undefined;
}

/**
 * Calculate the 2-byte ETag for a Valve Actuator config block (27 bytes).
 */
function calculateVADeviceETag(fields) {
    /**
     * Deterministic 27-byte block construction based on firmware priority sequence:
     * 1. HVAC Diagnostic (2 bytes)
     * 2. Mounting (8 bytes)
     * 3. Bindings (8 bytes)
     * 4. UI Flags (2 bytes)
     * 5. Home ID (4 bytes)
     * 6. Flag 0x0143 (1 byte)
     * 7. Orientation (2 bytes)
     * Total: 27 bytes
     */
    const buffer = Buffer.alloc(27);
    let offset = 0;

    // 1. HVAC Diagnostic (2 bytes)
    const hvac = Number(getFieldVal(fields, 0x015d) || 0);
    buffer.writeUInt16BE(hvac, offset); offset += 2;

    // 2. Mounting (8 bytes) - Currently 0x016e is often zeroed in RAM-snapshot
    offset += 8;

    // 3. Bindings (8 bytes)
    const bindingsRaw = getFieldVal(fields, 0x015e) || [];
    const bindings = Array.isArray(bindingsRaw) ? bindingsRaw : [bindingsRaw];
    for (let i = 0; i < 4 && i * 2 < 8; i++) {
        const pair = bindings[i];
        if (pair) {
            const val = typeof pair === 'string' ? parseInt(pair, 16) : Number(pair);
            buffer.writeUInt16BE(val, offset + i * 2);
        }
    }
    offset += 8;

    // 4. UI Flags (2 bytes)
    const uiFlags = Number(getFieldVal(fields, 0x0158) || 0);
    buffer.writeUInt16BE(uiFlags, offset); offset += 2;

    // 5. Home ID (4 bytes)
    const homeId = Number(getFieldVal(fields, 0x015c) || 0);
    buffer.writeUInt32BE(homeId, offset); offset += 4;

    // 6. Device Flag 0x0143 (1 byte)
    const flag = getFieldVal(fields, 0x0143) ? 1 : 0;
    buffer.writeUInt8(flag, offset); offset += 1;

    // 7. Orientation (2 bytes)
    const orient = Number(getFieldVal(fields, 0x0149) || 0);
    buffer.writeUInt16BE(orient, offset); offset += 2;

    let hash = 0;
    for (let i = 0; i < buffer.length; i++) {
        hash = tadoHashStep(buffer[i], hash);
    }
    return hash;
}


/**
 * Safely parse a JSON string or buffer from MySQL, handling 'longtext' edge cases.
 */
function safeJsonParse(data) {
    if (data === null || data === undefined) return {};
    try {
        const str = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
        if (str === 'null' || !str) return {};
        return JSON.parse(str);
    } catch (e) {
        _log('error', `JSON parse error: ${e.message} (data: ${data})`);
        return {};
    }
}

let pool = null;
let offlineState = false;

function setOfflineState(state, err = null) {
    if (offlineState !== state) {
        offlineState = state;
        if (state) {
            _log('warn', `[WARN] MariaDB connection failed (${err ? err.message : 'Unknown'}). Entering DB offline mode.`);
        } else {
            _log('info', `[INFO] MariaDB connection restored. Leaving DB offline mode.`);
        }
    }
}

function isOffline() {
    return offlineState;
}

function handleDbError(err) {
    if (err && (
        err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH' ||
        (err.message && (err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND') || err.message.includes('ETIMEDOUT') || err.message.includes('EHOSTUNREACH')))
    )) {
        setOfflineState(true, err);
        return true;
    }
    return false;
}

let _healthCheckInterval = null;

// ==========================================
// 1. Connection & Lifecycle Management
// ==========================================

/**
 * Get or create the MySQL connection pool.
 * Configured with settings from lib/config.js.
 * 
 * @returns {mysql.Pool} The active MySQL pool.
 */
function getPool() {
    if (!pool) {
        try {
            const dbConfig = {
                host: config.db.host,
                port: config.db.port || 3306,
                database: config.db.database,
                user: config.db.user,
                password: config.db.password,
                charset: 'utf8mb4',
                timezone: 'Z',
                waitForConnections: true,
                connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || (process.env.IS_CHILD_PROCESS === 'true' ? '15' : '25'), 10),
                maxIdle: 10,
                idleTimeout: 60000,
                queueLimit: 50,
                enableKeepAlive: true,
                keepAliveInitialDelay: 10000,
                connectTimeout: 10000
            };
            _log('info', `Creating pool for ${dbConfig.user}@${dbConfig.host}/${dbConfig.database}`);
            const rawPool = mysql.createPool(dbConfig);
            
            const wrapPromise = (origFn, context) => {
                return async function(...args) {
                    try {
                        return await origFn.apply(context, args);
                    } catch (err) {
                        handleDbError(err);
                        throw err;
                    }
                };
            };

            rawPool.query = wrapPromise(rawPool.query, rawPool);
            rawPool.execute = wrapPromise(rawPool.execute, rawPool);

            const origGetConnection = rawPool.getConnection;
            rawPool.getConnection = async function(...args) {
                try {
                    const conn = await origGetConnection.apply(rawPool, args);
                    if (conn) {
                        conn.query = wrapPromise(conn.query, conn);
                        conn.execute = wrapPromise(conn.execute, conn);
                        if (conn.beginTransaction) conn.beginTransaction = wrapPromise(conn.beginTransaction, conn);
                        if (conn.commit) conn.commit = wrapPromise(conn.commit, conn);
                        if (conn.rollback) conn.rollback = wrapPromise(conn.rollback, conn);
                    }
                    return conn;
                } catch (err) {
                    handleDbError(err);
                    throw err;
                }
            };

            rawPool.on('connection', (conn) => {
                conn.promise().query("SET time_zone = '+00:00'").catch(err => {
                    _log('error', `Failed to set session time_zone to UTC: ${err.message}`);
                });
            });
            _log('info', `Pool created.`);
            pool = rawPool;

            if (!_healthCheckInterval) {
                _healthCheckInterval = setInterval(async () => {
                    if (pool) {
                        try {
                            await pool.query('SELECT 1');
                            setOfflineState(false);
                        } catch (e) {
                            handleDbError(e);
                        }
                    }
                }, 30000);
                _healthCheckInterval.unref();
            }
        } catch (e) {
            _log('error', `FAILED to create pool: ${e.message}`);
            throw e;
        }
    }
    return pool;
}

/**
 * Gracefully close the database pool.
 */
async function close() {
    if (_healthCheckInterval) {
        clearInterval(_healthCheckInterval);
        _healthCheckInterval = null;
    }
    if (pool) {
        await pool.end();
        pool = null;
    }
}

/**
 * Bootstrap the database.
 * Connects to the database server, creates the database if it doesn't exist,
 * and seeds it from ws-server/tanoclo.sql if it's empty.
 */
async function bootstrap() {
    const fs = require('fs');
    const path = require('path');

    _log('info', `Checking database connection to host ${config.db.host}...`);
    let conn;
    try {
        conn = await mysql.createConnection({
            host: config.db.host,
            port: 3306,
            user: config.db.user,
            password: config.db.password,
            connectTimeout: 10000
        });
    } catch (err) {
        _log('error', `[BOOTSTRAP FATAL] Cannot connect to MariaDB host: ${err.message}`);
        throw err;
    }

    try {
        const dbName = config.db.database;
        if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
            throw new Error(`Invalid database name: "${dbName}" — must contain only alphanumeric characters and underscores`);
        }
        _log('info', `Ensuring database \`${dbName}\` exists...`);
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    } catch (err) {
        _log('error', `[BOOTSTRAP FATAL] Failed to create database: ${err.message}`);
        throw err;
    } finally {
        try { await conn.end(); } catch (e) { _log('debug', `conn.end error in bootstrap: ${e.message}`); }
    }

    // Now connect to the pool to check tables
    const p = getPool();
    let tables;
    try {
        const [rows] = await p.query('SHOW TABLES');
        tables = rows;
    } catch (err) {
        _log('error', `[BOOTSTRAP FATAL] Failed to check tables: ${err.message}`);
        throw err;
    }

    if (tables.length === 0) {
        _log('info', `Database is empty. Seeding from tanoclo.sql...`);
        const sqlPath = path.join(__dirname, '../tanoclo.sql');
        if (!fs.existsSync(sqlPath)) {
            const err = new Error(`Seeding file not found at ${sqlPath}`);
            _log('error', `[BOOTSTRAP FATAL] ${err.message}`);
            throw err;
        }

        const sqlContent = fs.readFileSync(sqlPath, 'utf8');
        const queries = [];
        let currentQuery = '';
        const lines = sqlContent.split(/\r?\n/);
        for (let line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('#')) {
                continue;
            }
            currentQuery += line + '\n';
            if (trimmed.endsWith(';')) {
                queries.push(currentQuery.trim());
                currentQuery = '';
            }
        }
        if (currentQuery.trim()) {
            queries.push(currentQuery.trim());
        }

        _log('info', `Found ${queries.length} queries to execute.`);
        const dbConn = await p.getConnection();
        try {
            await dbConn.beginTransaction();
            for (let i = 0; i < queries.length; i++) {
                const q = queries[i];
                // Skip transactions or commit statements inside the file to avoid conflicts with our transaction wrapper
                const upper = q.toUpperCase();
                if (upper.startsWith('START TRANSACTION') || upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
                    continue;
                }
                try {
                    await dbConn.query(q);
                } catch (queryErr) {
                    _log('error', `Query failed at index ${i}: ${q.substring(0, 100)}...`);
                    throw queryErr;
                }
            }
            await dbConn.commit();
            _log('info', `Database successfully seeded from tanoclo.sql.`);
        } catch (err) {
            _log('error', `[BOOTSTRAP FATAL] Seeding failed: ${err.message}`);
            try { await dbConn.rollback(); } catch (e) { _log('debug', `Rollback error in bootstrap: ${e.message}`); }
            throw err;
        } finally {
            dbConn.release();
        }
    } else {
        _log('info', `Database already exists and has ${tables.length} tables. Skipping seed.`);
    }
}

// Helpers/Mappers used by other modules
/**
 * Normalize a device serial string (trim whitespace).
 * Historically named extractShortSerial - kept as alias for backward compat.
 */
function normalizeSerial(deviceId) {
    if (!deviceId) return null;
    return deviceId.trim();
}

function tlvNameToHex(name) {
    const tlv = require('./tlv');
    const fid = tlv.getFidByLabelName(name);
    if (fid !== null && fid !== undefined) {
        return '0x' + fid.toString(16).toLowerCase().padStart(4, '0');
    }
    return null;
}

function cleanFriendlyConfig(fields) {
    if (!fields || typeof fields !== 'object') return {};
    const tlv = require('./tlv');
    const cleaned = {};
    for (const [k, v] of Object.entries(fields)) {
        if (v === null || v === undefined) continue;
        let hexKey;
        let isExplicitHex = false;
        if (k.startsWith('0x')) {
            const fid = parseInt(k, 16);
            if (!isNaN(fid)) {
                hexKey = '0x' + fid.toString(16).toLowerCase().padStart(4, '0');
                isExplicitHex = true;
            }
        } else {
            const fid = tlv.getFidByLabelName(k);
            if (fid !== null && fid !== undefined) {
                hexKey = '0x' + fid.toString(16).toLowerCase().padStart(4, '0');
            }
        }
        if (hexKey) {
            if (cleaned[hexKey] === undefined || isExplicitHex) {
                cleaned[hexKey] = v;
            }
        }
    }
    return cleaned;
}

/**
 * Returns internal pool statistics.
 * NOTE: Accesses mysql2 private properties (_allConnections, _freeConnections,
 * _connectionQueue). Verified against mysql2 v3.x - may break on major upgrades.
 */
function getPoolStats() {
    if (!pool) return null;
    const p = pool.pool || pool;
    return {
        total: p._allConnections?.length ?? 0,
        idle: p._freeConnections?.length ?? 0,
        waiting: p._connectionQueue?.length ?? 0,
        limit: p.config?.connectionLimit ?? 25
    };
}

module.exports = {
    getPool,
    getPoolStats,
    close,
    bootstrap,
    isOffline,
    handleDbError,
    generateEtag,
    hashToken,
    safeJsonParse,
    getFieldVal,
    tadoHashStep,
    calculateVADeviceETag,
    mapOrientation,
    unmapOrientation,
    mapMountState,
    extractShortSerial: normalizeSerial,
    normalizeSerial,
    cleanFriendlyConfig,
    tlvNameToHex,
    _log
};

/**
 * @file lib/logger.js
 * @brief Unified log transport and severity levels printer.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const logDir = path.join(__dirname, '../log');
let logFile = path.join(logDir, 'debug.log');

try {
    fs.appendFileSync(logFile, '');
} catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
        logFile = path.join(logDir, 'debug.local.log');
    }
}

let currentLogDate = new Date().toISOString().split('T')[0];

// Line-buffering to prevent out-of-order logs during heavy traffic
let logBuffer = [];
const FLUSH_INTERVAL_MS = 500;

function rotate(oldDate) {
    if (!fs.existsSync(logFile)) return;

    try {
        const stats = fs.statSync(logFile);
        if (stats.size === 0) return;

        const mtimeDate = stats.mtime.toISOString().split('T')[0];
        // If file already written today, rotation already done by other process
        if (mtimeDate !== oldDate) {
            return;
        }

        const baseName = path.basename(logFile, '.log');
        const rotatedPath = path.join(logDir, `${baseName}.${oldDate}.log`);

        if (fs.existsSync(rotatedPath)) {
            // Append and truncate to prevent overwriting existing rotated logs
            const content = fs.readFileSync(logFile);
            fs.appendFileSync(rotatedPath, content);
            fs.writeFileSync(logFile, '');
        } else {
            fs.renameSync(logFile, rotatedPath);
        }
    } catch (e) {
        console.error(`[LOGGER] Failed to rotate log: ${e.message}`);
    }
}

if (fs.existsSync(logFile)) {
    try {
        const stats = fs.statSync(logFile);
        const mtimeDate = stats.mtime.toISOString().split('T')[0];
        if (mtimeDate !== currentLogDate) {
            rotate(mtimeDate);
        }
    } catch (e) {
        console.error(`[LOGGER] Startup check failed: ${e.message}`);
    }
}

function flushLogs() {
    if (logBuffer.length === 0) return;
    const data = logBuffer.join('\n') + '\n';
    logBuffer = [];
    fs.appendFile(logFile, data, (err) => {
        if (err) console.error(`[LOGGER] Write error: ${err.message}`);
    });
}

// Ensure logs are flushed periodically
setInterval(flushLogs, FLUSH_INTERVAL_MS).unref();

// Ensure logs are flushed on exit
process.on('exit', flushLogs);
process.on('SIGINT', () => { flushLogs(); });

function maskSerials(str, level) {
    if (level === 'debug') return str;
    // Mask Tado serials (e.g. VA1234567890) for non-debug logs
    return str.replace(/([A-Z]{2,3})\d{6,12}/g, '$1********');
}

function redactSensitive(str, level) {
    if (level === 'debug') return str;
    // Redact JWT tokens (eyJ...)
    str = str.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'eyJ***REDACTED***');
    // Redact Bearer tokens in headers
    str = str.replace(/(Bearer\s+)[A-Za-z0-9_.-]{20,}/gi, '$1***REDACTED***');
    // Redact hex strings that look like token hashes (64+ hex chars)
    str = str.replace(/(['"]?(?:token|secret|password|access_token|refresh_token)['"]?\s*[:=]\s*['"]?)([a-f0-9]{40,})/gi, '$1***REDACTED***');
    return str;
}

function getLogger(context) {
    function log(level, ...args) {
        const currentLevel = levels[config.logLevel] || 0;
        const msgLevel = levels[level] || 0;

        if (msgLevel >= currentLevel) {
            const now = new Date();
            const ts = now.toISOString();
            const dateStr = ts.split('T')[0];

            if (dateStr !== currentLogDate) {
                flushLogs(); // Flush before rotating
                rotate(currentLogDate);
                currentLogDate = dateStr;
            }

            const ctxStr = context ? `[${context}] ` : '';
            let msgStr = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
            
            // Apply serial masking and sensitive data redaction for production-like (INFO+) output
            msgStr = maskSerials(msgStr, level);
            msgStr = redactSensitive(msgStr, level);

            const formattedMsg = `[${ts}] [${level.toUpperCase()}] ${ctxStr}${msgStr}`;

            console.log(formattedMsg);

            // Always write to the debug.log file if the level is high enough, 
            // but the buffer size limits the immediate write overhead.
            logBuffer.push(formattedMsg);
            if (logBuffer.length > 100) flushLogs();
        }
    }

    log.debug = (...args) => log('debug', ...args);
    log.info = (...args) => log('info', ...args);
    log.warn = (...args) => log('warn', ...args);
    log.error = (...args) => log('error', ...args);

    return log;
}

module.exports = { getLogger };

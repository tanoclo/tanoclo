/**
 * @file api/server.js
 * @brief Express.js server configuring the HTTP API routes.
 * 
 * Sets up security headers (Helmet), CORS, JSON/cookie parsers, logging, DB fallback handling,
 * and mounts the API routes (auth, setup, zones, homes, etc.) to expose the reconstituted
 * Tado REST endpoints.
 */

const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const db = require('../lib/db');
const { getLogger } = require('../lib/logger');
const _log = getLogger('api');
const authMiddleware = require('./middleware/auth');
const heating = require('./routes/heating');
const setupRouter = require('./routes/setup');
const config = require('../lib/config');
const commandLog = require('../lib/command-log');
const otaSync = require('../lib/ota-sync');
const rateLimit = require('express-rate-limit');
const { reconstructBuffers } = require('../lib/utils');

const app = express();

app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
});

// Request logging - logs slow requests (>1s) and errors (status >= 400)
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        // Skip noisy health checks and static assets
        if (req.path === '/api/health' || req.path === '/api/public/health' || req.path.startsWith('/assets/') || req.path.startsWith('/media/') || req.path.startsWith('/images/')) return;
        if (duration > 1000 || res.statusCode >= 400) {
            _log('debug', `[REQ] ${req.requestId} ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
        }
    });
    next();
});

app.use((req, res, next) => {
    if (db.isOffline()) {
        if (req.accepts('html')) {
            res.status(503).send('<html><body><h1>Service Unavailable</h1><p>System is undergoing maintenance (MariaDB offline). Please try again in a few moments.</p></body></html>');
        } else {
            res.status(503).json({ error: 'Service Unavailable (Database Maintenance)' });
        }
        return;
    }
    next();
});

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "connect-src": ["'self'", `*.${config.domain}`, "fonts.googleapis.com", "*.googleapis.com", "*.google.com", "*.gstatic.com", "https://cdn.jsdelivr.net", "tado:", "*.basemaps.cartocdn.com", "*.tile.openstreetmap.org"],
            "script-src": ["'self'", "'unsafe-inline'", `*.${config.domain}`, "maps.googleapis.com", "https://cdn.jsdelivr.net"],
            "script-src-elem": ["'self'", "'unsafe-inline'", `*.${config.domain}`, "maps.googleapis.com", "https://cdn.jsdelivr.net"],
            "script-src-attr": ["'self'", "'unsafe-inline'", "'unsafe-hashes'"],
            "style-src": ["'self'", "'unsafe-inline'", `*.${config.domain}`, "fonts.googleapis.com", "https://cdn.jsdelivr.net"],
            "style-src-elem": ["'self'", "'unsafe-inline'", `*.${config.domain}`, "fonts.googleapis.com", "https://cdn.jsdelivr.net"],
            "img-src": ["'self'", "data:", `*.${config.domain}`, "maps.googleapis.com", "*.gstatic.com", "*.google.com", "*.googleapis.com", "*.basemaps.cartocdn.com", "*.tile.openstreetmap.org"],
            "form-action": ["'self'", `*.${config.domain}`, "tado:"],
            "font-src": ["'self'", "fonts.gstatic.com", "https://cdn.jsdelivr.net", "data:"]
        },
    },
}));

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
});

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const allowed = (
            origin === `https://${config.domain}` ||
            origin.endsWith(`.${config.domain}`) ||
            origin === 'http://localhost' ||
            origin === 'https://localhost' ||
            origin === 'capacitor://localhost' ||
            origin === 'ionic://localhost' ||
            /^https?:\/\/localhost(:\d+)?$/.test(origin)
        );
        if (allowed) {
            callback(null, true);
        } else {
            _log('warn', `[CORS] Denied origin: ${origin}`);
            callback(null, false);
        }
    },
    credentials: true
}));



// Derive a separate cookie-signing key from the JWT secret to limit blast radius if either is compromised
function getCookieSigningKey() {
    return crypto.createHmac('sha256', config.jwtSecret).update('cookie-signing').digest('hex');
}
app.use((req, res, next) => cookieParser(getCookieSigningKey())(req, res, next));

app.set('trust proxy', 1); // Trust only the first reverse proxy hop
app.set('etag', false);

app.use((req, res, next) => {
    if (req.hostname && req.hostname.startsWith('setup.') && !req.url.startsWith('/setup')) {
        const isExempt = req.url.startsWith('/api') ||
            req.url.startsWith('/oauth') ||
            req.url.startsWith('/graphql');
        if (!isExempt) {
            req.url = '/setup' + req.url;
        }
    }
    next();
});

const frontendPath = path.join(__dirname, '../frontend-dist');
const validLangs = ['de', 'en', 'es', 'fr', 'it', 'nl'];

// Early Language Redirection / cookie set and strip prefix for app.* hosts
app.use((req, res, next) => {
    if (req.method === 'GET') {
        const urlPath = req.path;
        const match = urlPath.match(/^\/(de|en|es|fr|it|nl)(\/.*)?$/);
        if (match) {
            const lang = match[1];
            const remainingPath = match[2] || '/';
            // Set locale cookie
            res.cookie('tado_locale', lang, { maxAge: 31536000 * 1000, path: '/', sameSite: 'Lax', httpOnly: true });
            // Redirect to prefixless path
            return res.redirect(302, remainingPath);
        }
    }
    next();
});

app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(frontendPath, 'sw.js'));
});

app.use('/assets', express.static(path.join(frontendPath, 'assets'), { maxAge: '30d' }));
app.use('/media', express.static(path.join(frontendPath, 'media'), { maxAge: '30d' }));
app.use('/images', express.static(path.join(frontendPath, 'images'), { maxAge: '30d' }));
app.use(express.static(frontendPath, {
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

app.use((req, res, next) => {
    const host = req.hostname || '';
    const urlPath = req.path || '';

    // susi.* or promotions/notifications path
    if (host.includes('susi') || urlPath.includes('/promotions') || urlPath.includes('/notifications')) {
        if (req.url.includes('skills')) return next();
        return res.json({ notifications: [], promotions: [] });
    }

    // minder.* or incidents path
    if (host.includes('minder') || urlPath.includes('/incidents')) {
        if (req.url.includes('runningTimes')) return next();
        return res.json({ incidents: [] });
    }

    // energy-insights.* or related paths
    if (host.includes('energy-insights') || urlPath.includes('/energy-insights') || urlPath.includes('/meterReadings') || urlPath.includes('/savingsAdvice')) {
        if (req.url.includes('banners')) return res.json({ bannersToShow: [] });
        if (req.url.includes('savingsAdvice')) return res.json({ owd: null, showBanner: false });
        if (req.url.includes('meterReadings')) return res.json({ readings: [] });
        if (req.url.includes('settings')) return res.json({ meterType: 'GAS', meterReadingUnit: 'M3', isMeterReadingUnitChangeAllowed: true });
    }

    // tariff-experience.* (Features)
    if (host.includes('tariff-experience') || urlPath.includes('/tariff-experience')) {
        return res.json({
            canAccessEnergyPrices: false,
            canAccessEnergyReadings: false,
            canAccessPushNotificationSettings: false,
            isAccountOwner: false,
            isAccountLinkedToHome: false,
            canAccessConsumption: false
        });
    }

    // hops.* (Tado X - Rooms and Devices)
    if (host.includes('hops')) {
        return next();
    }

    // users.*
    if (host.includes('users')) {
        return next();
    }

    next();
});

// Force application/json for requests that appear to have a body but miss the header
app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.headers['content-type'] && req.get('content-length') > 0) {
        req.headers['content-type'] = 'application/json';
    }
    next();
});

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// Validate numeric route params early to return clear 400 errors
app.param('homeId', (req, res, next, value) => {
    if (!/^\d+$/.test(value)) return res.status(400).json({ error: 'invalid_home_id', error_description: 'homeId must be numeric' });
    next();
});
app.param('zoneId', (req, res, next, value) => {
    if (!/^\d+$/.test(value)) return res.status(400).json({ error: 'invalid_zone_id', error_description: 'zoneId must be numeric' });
    next();
});

// CSRF Protection: validate Origin/Referer for state-mutating requests
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;

    // Fall back to Referer verification if origin is missing or is the string "null"
    if (!origin || origin === 'null') {
        const referer = req.headers.referer;
        if (!referer) return next(); // Allow requests with neither (non-browser clients, API calls)
        try {
            const refUrl = new URL(referer);
            if (refUrl.hostname === 'localhost' ||
                refUrl.hostname === '127.0.0.1' ||
                refUrl.hostname === config.domain ||
                refUrl.hostname.endsWith('.' + config.domain)) {
                return next();
            }
        } catch (e) {
            // Malformed referer
        }
        _log('warn', `[CSRF] Blocked ${req.method} ${req.url} (origin: ${origin}, referer: ${referer})`);
        return res.status(403).json({ error: 'forbidden', error_description: 'Cross-origin request blocked' });
    }

    try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' ||
            url.hostname === '127.0.0.1' ||
            url.hostname === config.domain ||
            url.hostname.endsWith('.' + config.domain)) {
            return next();
        }
    } catch (e) {
        // Malformed origin header
    }
    _log('warn', `[CSRF] Blocked ${req.method} ${req.url} from origin: ${origin}`);
    return res.status(403).json({ error: 'forbidden', error_description: 'Cross-origin request blocked' });
});

// Command Log: log POST/PUT/DELETE API requests to dedicated commands.log
app.use((req, res, next) => {
    if (commandLog.isEnabled() && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
        // Skip noisy/irrelevant endpoints
        const skip = req.url.includes('/installations') ||
            req.url.includes('/events/track') ||
            req.url.includes('/health') ||
            req.url.includes('/dev/null');
        if (!skip) {
            commandLog.logApiRequest(req.method, req.originalUrl || req.url, req.body, req.params);
        }
    }
    next();
});

// --- Mock Analytics & Bootstrap Endpoints ---
// Satisfy app initialization without sending data to 3rd parties

// Iterable Installations
app.post(['/projects/:project/installations', '/:any/projects/:project/installations'], (req, res) => {
    _log('info', `[MOCK] Iterable installation registered: ${req.url}`);
    res.json({ deviceId: 'mock-iterable-device-id-' + Date.now() });
});

// Iterable Events
app.post(['/v1/events/track', '/:any/v1/events/track'], (req, res) => {
    res.json({ status: 'Success' });
});

// Firebase Installations
app.post(['/v1/projects/:project/installations', '/:any/v1/projects/:project/installations'], (req, res) => {
    _log('info', `[MOCK] Firebase installation registered: ${req.url}`);
    res.json({
        fid: 'f' + crypto.randomBytes(10).toString('hex'),
        refreshToken: 'mock-refresh-token-' + Date.now(),
        authToken: {
            token: 'mock-auth-token-' + Date.now(),
            expiresIn: '3600s'
        }
    });
});

app.use((req, res, next) => {
    if (req.url.startsWith('/dev/null')) return res.json({});
    if (req.url.startsWith('/index.php/')) {
        req.url = req.url.replace('/index.php/', '/');
    } else if (req.url === '/index.php') {
        req.url = '/';
    }
    next();
});


// Health
app.get('/api/public/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/api/health', authMiddleware, async (req, res) => {
    const checks = { db: 'unknown', uptime: process.uptime() };
    let healthy = true;

    try {
        const pool = db.getPool();
        const start = Date.now();
        await pool.execute('SELECT 1');
        checks.db = 'ok';
        checks.dbLatencyMs = Date.now() - start;
    } catch (e) {
        checks.db = 'error';
        checks.dbError = e.code || e.message;
        healthy = false;
    }

    const poolStats = db.getPoolStats();
    if (poolStats) {
        checks.pool = poolStats;
    }

    try {
        const mqttClient = require('../lib/mqtt-client');
        checks.mqtt = { connected: mqttClient.isConnected() };
    } catch (e) {
        checks.mqtt = { connected: false, error: e.message };
    }

    checks.status = healthy ? 'healthy' : 'degraded';
    checks.service = 'tanoclo-node-api';
    checks.version = require('../package.json').version;
    checks.timestamp = new Date().toISOString();

    res.status(healthy ? 200 : 503).json(checks);
});
// Skills route is handled by homes.js (canonical handler with richer response)

const commandRouter = express.Router();
function setupCommandRoutes(opts) {
    const commandApi = require('../lib/command-api');
    const realRouter = commandApi.getRouter(opts);
    commandRouter.use(realRouter);
    if (opts.messageCache) {
        setupRouter.setDownlinkCache(opts.messageCache);
    }
}
app.use('/api', commandRouter);

// Rate limiting for auth and sensitive endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15, // limit each IP to 15 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    message: { error: 'too_many_requests', error_description: 'Too many requests, please try again later.' }
});

app.use('/oauth2', authLimiter);
app.use('/oauth', authLimiter);
app.use('/login', authLimiter);
app.use('/setup/api/login', authLimiter);

// Swagger UI Docs setup
const swaggerUi = require('swagger-ui-express');
const yaml = require('yaml');
const adminAuth = require('./middleware/admin-auth');

const openapiSpecPath = path.join(__dirname, 'openapi.yaml');
let cachedSpec = null;
let cachedSpecMtime = 0;

function getSpec() {
    try {
        if (!fs.existsSync(openapiSpecPath)) return null;
        const stat = fs.statSync(openapiSpecPath);
        if (!cachedSpec || stat.mtimeMs !== cachedSpecMtime) {
            cachedSpec = yaml.parse(fs.readFileSync(openapiSpecPath, 'utf8'));
            cachedSpecMtime = stat.mtimeMs;
            _log('info', 'OpenAPI spec (re)loaded');
        }
    } catch (e) {
        _log('error', `Failed to parse openapi.yaml: ${e.message}`);
        return cachedSpec;
    }
    return cachedSpec;
}


app.use(['/api/docs', '/setup/api/docs'], adminAuth, (req, res, next) => {
    if (!config.swaggerEnabled) {
        return res.status(404).send('Not Found');
    }
    const spec = getSpec();
    if (!spec) return res.status(500).send('API spec failed to load.');
    next();
}, swaggerUi.serve, (req, res) => {
    swaggerUi.setup(getSpec(), {
        customSiteTitle: 'TaNoClo API Documentation',
        customCss: `
            .auth-flow .wrapper:has(input[name="client_id"]),
            .auth-flow .wrapper:has(input[name="client_secret"]),
            .auth-flow .wrapper:has(select) {
                display: none !important;
            }
        `,
        swaggerOptions: {
            initOAuth: {
                clientId: 'tado-web-app',
                clientSecret: 'public-api-key'
            }
        },
        customJsStr: `
            window.addEventListener('load', function() {
                setTimeout(function() {
                    if (window.ui) {
                        // Dynamically hide OAuth client_id, client_secret, and client credentials location fields to avoid user confusion
                        const observer = new MutationObserver(function() {
                            const selectors = [
                                '[data-name="clientId"]',
                                '#client_id_password',
                                '[data-name="clientSecret"]',
                                '#client_secret_password',
                                '[data-name="passwordType"]',
                                '#password_type'
                            ];
                            selectors.forEach(function(selector) {
                                const el = document.querySelector(selector);
                                if (el) {
                                    const row = el.closest('.wrapper') || el.closest('.row') || el.closest('tr') || el.parentElement;
                                    if (row) {
                                        row.style.setProperty('display', 'none', 'important');
                                    }
                                }
                            });
                        });
                        observer.observe(document.body, { childList: true, subtree: true });
                    }
                }, 500);
            });
        `
    })(req, res);
});

app.get(['/api/openapi.json', '/setup/api/openapi.json'], adminAuth, (req, res) => {
    if (!config.swaggerEnabled) {
        return res.status(404).json({ error: 'not_found' });
    }
    const spec = getSpec();
    if (!spec) return res.status(500).json({ error: 'failed_to_load' });
    res.json(spec);
});

// Route mount path prefixes for home-scoped routes
const HOME_PREFIXES = ['/api/v1/homes', '/v1/homes', '/api/v2/homes', '/api/homes', '/homes'];

// Routers
const sseRouter = require('./routes/sse');
app.use('/api', sseRouter.router);
app.use('/setup', setupRouter.router);
app.use('/', require('./routes/auth'));
app.use('/api/v1/homes/:homeId/runningTimes', authMiddleware, heating.getRunningTimes);
app.use('/v1/homes/:homeId/runningTimes', authMiddleware, heating.getRunningTimes);
// mobileDevices MUST come first: its geofenceWebhook route is registered before
// router.use(authMiddleware), but homes/zones/devices/heating apply auth to ALL
// incoming requests. If homes.js is mounted first, its blanket auth rejects the
// webhook (no Authorization header) before mobileDevices ever sees it.
app.use(HOME_PREFIXES, require('./routes/mobileDevices').router);
app.use(HOME_PREFIXES, require('./routes/homes'));
app.use(HOME_PREFIXES, require('./routes/zones'));
app.use(HOME_PREFIXES, require('./routes/devices'));
app.use(HOME_PREFIXES, heating.router);
app.use(HOME_PREFIXES, require('./routes/tanoclo'));

app.use('/api/logs', (req, res, next) => {
    req.url = '/logs' + req.url;
    next();
}, require('./routes/homes'));

app.use(['/', '/api/v2'], require('./routes/users'));

app.use('/api/v2/devices', require('./routes/devices'));
app.use('/api/v2/ota', require('./routes/ota'));
app.use(['/api/v2/bridges', '/api/v2/homeByBridge'], require('./routes/bridges'));
app.use('/api/v2/users', require('./routes/users'));
app.use('/api/v2/graphql', require('./routes/graphql'));
app.use('/apps/graphql', require('./routes/graphql'));
app.use('/graphql', require('./routes/graphql'));
app.use('/', require('./routes/misc'));

// Fallback for non-app root
app.get('/', (req, res) => {
    const indexFile = path.join(frontendPath, 'index.html');
    if (fs.existsSync(indexFile)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        return res.sendFile(indexFile);
    }
    res.send('TaNoClo API / WS Server is running');
});

let finalized = false;

function finalizeMiddleware() {
    if (finalized) return;

    // SPA catch-all for any other routes (non-API, non-setup)
    // Uses Express 5 named wildcard syntax; req.params.path captures the matched path
    app.get('/{*path}', (req, res, next) => {
        const urlPath = req.path || '';

        // If it's an API route, static asset, or has a file extension, let it go to 404
        if (urlPath.startsWith('/api') ||
            urlPath.startsWith('/oauth2') ||
            urlPath.startsWith('/graphql') ||
            urlPath.startsWith('/setup') ||
            urlPath.startsWith('/location') ||
            urlPath.startsWith('/assets/') ||
            urlPath.startsWith('/media/') ||
            urlPath.startsWith('/images/') ||
            path.extname(urlPath)) {
            return next();
        }

        // Serve index.html for SPA client-side routing
        const indexFile = path.join(frontendPath, 'index.html');
        if (fs.existsSync(indexFile)) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.sendFile(indexFile);
        } else {
            res.status(404).send('Frontend build not found. Please run npm run build in frontend-new.');
        }
    });

    // 404 Capture
    app.use((req, res) => {
        const isScan = req.url.includes('.php') ||
            req.url.includes('.env') ||
            req.url.includes('wp-') ||
            req.url.includes('cgi-bin') ||
            req.url.includes('phpmyadmin') ||
            req.url.includes('.git') ||
            req.url.startsWith('/.');
        if (!isScan) {
            _log('warn', `[API] 404 ${req.method} ${req.url} (Host: ${req.hostname})`);
        }
        if (req.url.startsWith('/assets/') || req.url.endsWith('.css') || req.url.endsWith('.js')) {
            return res.status(404).type('text/plain').send('Asset Not Found');
        }
        res.status(404).json({ errors: [{ code: 'notFound', title: 'Route not found' }] });
    });

    // Global error handler
    app.use((err, req, res, next) => {
        if (db.handleDbError && db.handleDbError(err)) {
            _log('error', `[REST-API] Database connection error: ${err.message}`);
            return res.status(503).json({ errors: [{ code: 'service_unavailable', title: 'Service Unavailable (Database Maintenance)' }] });
        }
        _log('error', err.stack);
        res.status(500).json({ errors: [{ code: 'internal_error', title: 'Internal Server Error' }] });
    });

    finalized = true;
}

const PORT = process.env.API_PORT || 3111;

app.get('/favicon.ico', (req, res) => {
    const iconFile = path.join(frontendPath, 'favicon.svg');
    if (fs.existsSync(iconFile)) {
        res.sendFile(iconFile);
    } else {
        res.sendStatus(404);
    }
});

async function startAPI() {
    finalizeMiddleware();

    // Load config from DB to get MQTT settings
    try {
        await config.loadFromDb();
        _log('info', `[REST-API] Loaded config from database`);
    } catch (err) {
        _log('error', `[REST-API] Failed to load config from DB: ${err.message}`);
    }

    try {
        const tlv = require('../lib/tlv');
        const labels = await db.getTlvLabels();
        tlv.init(labels.fields);
        _log('info', `[REST-API] Loaded TLV labels for config encoding`);
    } catch (err) {
        _log('error', `[REST-API] Failed to load TLV labels: ${err.message}`);
    }

    try {
        const mqttClient = require('../lib/mqtt-client');
        const mqttPublisher = require('../lib/mqtt-publisher');
        mqttClient.init(config, _log);
        mqttPublisher.init(mqttClient, db, config, _log);
        _log('info', `[REST-API] Initialized MQTT client and publisher`);
    } catch (mqttErr) {
        _log('error', `[REST-API] Failed to initialize MQTT: ${mqttErr.message}`);
    }
    try {
        otaSync.boot();
        _log('info', '[REST-API] Booted OTA Sync Manager');
    } catch (otaErr) {
        _log('error', `[REST-API] Failed booting OTA Sync Manager: ${otaErr.message}`);
    }

    const server = app.listen(PORT, '0.0.0.0', () => {
        _log('info', `[REST-API] Listening on all interfaces (0.0.0.0) port ${PORT}`);
    });

    // Graceful shutdown: stop accepting new connections, close DB pool
    const shutdown = () => {
        _log('info', '[REST-API] Graceful shutdown initiated...');
        server.close(() => {
            _log('info', '[REST-API] HTTP server closed');
            db.close().then(() => {
                _log('info', '[REST-API] DB pool closed');
                process.exit(0);
            }).catch(() => process.exit(0));
        });
        // Force exit if graceful shutdown takes too long
        setTimeout(() => process.exit(0), 5000);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if ((require.main === module || process.send || process.env.IS_CHILD_PROCESS === 'true') && !process.env.VITEST) {
    const clients = new Map();

    const sendToDevice = (deviceId, wsMessage) => {
        if (process.send) {
            process.send({ type: 'SEND_TO_DEVICE', deviceId, message: wsMessage });
        }
    };

    const broadcastTime = () => {
        if (process.send) {
            process.send({ type: 'BROADCAST_TIME' });
        }
    };

    const messageCacheMock = {
        getCache: () => {
            return new Promise((resolve) => {
                if (!process.send) {
                    return resolve({});
                }
                const requestId = crypto.randomUUID();
                const handler = (msg) => {
                    if (msg && msg.type === 'GET_MESSAGE_CACHE_RESPONSE' && msg.requestId === requestId) {
                        process.off('message', handler);
                        resolve(msg.cache);
                    }
                };
                process.on('message', handler);
                process.send({ type: 'GET_MESSAGE_CACHE', requestId });
                setTimeout(() => {
                    process.off('message', handler);
                    resolve({});
                }, 2000);
            });
        }
    };

    process.on('message', (msg) => {
        try {
            msg = reconstructBuffers(msg);
            if (!msg || !msg.type) return;

            switch (msg.type) {
                case 'SYNC_CLIENTS_RESPONSE': {
                    clients.clear();
                    if (Array.isArray(msg.clients)) {
                        for (const [deviceId, info] of msg.clients) {
                            clients.set(deviceId, info);
                        }
                    }
                    break;
                }
                case 'CLIENT_CONNECT': {
                    clients.set(msg.deviceId, msg.info);
                    break;
                }
                case 'CLIENT_DISCONNECT': {
                    clients.delete(msg.deviceId);
                    break;
                }
                case 'CLIENT_UPDATE': {
                    const existing = clients.get(msg.deviceId);
                    if (existing) {
                        Object.assign(existing, msg.updates);
                    }
                    break;
                }
                case 'ACK_RECEIVED': {
                    const commandApi = require('../lib/command-api');
                    if (commandApi.handleAckReceived) {
                        commandApi.handleAckReceived(msg.mid, { deviceId: msg.deviceId, coapMsg: msg.coapMsg });
                    }
                    if (msg.coapMsg && (msg.coapMsg.payload || msg.coapMsg.code)) {
                        const raw = msg.coapMsg.payload;
                        const payloadBuf = Buffer.isBuffer(raw) ? raw : (raw?.data ? Buffer.from(raw.data) : Buffer.alloc(0));
                        let parsedVal = null;
                        if (payloadBuf.length === 1) parsedVal = payloadBuf.readUInt8(0);
                        else if (payloadBuf.length === 2) parsedVal = payloadBuf.readUInt16BE(0);
                        else if (payloadBuf.length === 4) parsedVal = payloadBuf.readUInt32BE(0);

                        const devId = msg.deviceId;
                        const resolveHome = async () => {
                            if (!devId) return null;
                            let dev = await db.getDeviceBySerial(devId);
                            if (!dev) dev = await db.getDeviceByFullSerial(devId);
                            return dev ? dev.home_id : null;
                        };

                        resolveHome().then(homeId => {
                            if (homeId) {
                                const sse = require('./routes/sse');
                                _log('debug', `[SSE] Broadcasting device-debug-response for ${devId} (Home ${homeId}): ${payloadBuf.toString('hex')}`);
                                sse.broadcastToHome(homeId, 'device-debug-response', {
                                    deviceId: devId,
                                    mid: msg.mid,
                                    bytes: Array.from(payloadBuf),
                                    hex: payloadBuf.toString('hex'),
                                    val: parsedVal,
                                    code: msg.coapMsg.code
                                });
                            } else {
                                _log('debug', `[SSE] Could not resolve home for ${devId}, skipping SSE debug broadcast`);
                            }
                        }).catch(err => {
                            _log('error', `[SSE] Error resolving home for ${devId}: ${err.message}`);
                        });
                    }
                    break;
                }
                case 'STATE_CHANGE': {
                    const sse = require('./routes/sse');
                    sse.broadcastToHome(msg.homeId, msg.changeType, msg.data);
                    break;
                }
            }
        } catch (err) {
            _log('error', `[IPC] Error processing IPC message from master process: ${err.message}`);
        }
    });

    if (process.send) {
        process.send({ type: 'SYNC_CLIENTS' });
    }

    setupCommandRoutes({
        clients,
        sendToDevice,
        broadcastTime,
        log: _log,
        messageCache: messageCacheMock
    });

    startAPI();
}

module.exports = { app, startAPI, setupCommandRoutes };
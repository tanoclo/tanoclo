/**
 * @file api/routes/setup/portal/dashboard.js
 * @brief Admin setup portal dashboard overview routes.
 * 
 * Aggregates counts and statistics (total homes, physical devices, database users,
 * and active websocket sessions) to render status overviews on the portal dashboard.
 */

const express = require('express');
const db = require('../../../../lib/db');
const { getLogger } = require('../../../../lib/logger');
const adminAuth = require('../../../middleware/admin-auth');
const { renderLanguageSelector } = require('./i18n');

const router = express.Router();
const _log = getLogger('setup-api');

// --- Routes ---
router.get('/dashboard', adminAuth, async (req, res) => {
    try {
        const currentLocale = req.cookies?.tado_locale || 'en';
        const pool = db.getPool();
        const [homes] = await pool.execute(`
            SELECT h.*, 
            (SELECT COUNT(*) FROM devices d WHERE d.home_id = h.id) as device_count,
            (SELECT COUNT(*) FROM zones z WHERE z.home_id = h.id) as zone_count,
            (SELECT serial_no FROM devices d WHERE d.home_id = h.id AND d.device_type = 'IB01' LIMIT 1) as ib_serial
            FROM homes h
        `);

        const [devices] = await pool.execute(`
            SELECT d.*, h.name as home_name
            FROM devices d
            LEFT JOIN homes h ON d.home_id = h.id
            WHERE d.device_type != 'IB01'
            ORDER BY d.serial_no ASC
        `);

        const [whitelist] = await pool.execute('SELECT * FROM websocket_whitelist');

        const [users] = await pool.execute(`
            SELECT u.*, u.home_id as home_ids, h.name as home_name,
                   (CASE WHEN h.admin_user_id = u.id THEN 1 ELSE 0 END) as is_primary_admin
            FROM users u
            LEFT JOIN homes h ON u.home_id = h.id
            ORDER BY u.home_id ASC, u.name ASC
        `);

        const [admins] = await pool.execute('SELECT * FROM admin_users WHERE id = ?', [req.admin.id]);
        const admin = admins[0];

        res.send(`
            <html>
            <head>
                <title data-i18n="nav.portal_title">Setup Dashboard</title>
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
                <script src="/setup/i18n.js"></script>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
                    
                    body { 
                        background: #0a0a0a; 
                        color: #f0f0f0; 
                        font-family: 'Inter', sans-serif; 
                        -webkit-font-smoothing: antialiased;
                    }
                    
                    .navbar { 
                        background: rgba(26, 26, 26, 0.8) !important; 
                        backdrop-filter: blur(10px);
                        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                        padding: 1rem 2rem;
                    }
                    
                    .navbar-brand { font-weight: 600; letter-spacing: -0.5px; }

                    .container { max-width: 1100px; }
                    
                    .nav-tabs { border-bottom: 1px solid rgba(255, 255, 255, 0.1); gap: 8px; }
                    .nav-tabs .nav-link { 
                        color: #888; 
                        border: none; 
                        padding: 10px 20px; 
                        font-weight: 500; 
                        transition: all 0.2s ease;
                        border-radius: 8px 8px 0 0;
                    }
                    .nav-tabs .nav-link:hover { color: #fff; }
                    .nav-tabs .nav-link.active { 
                        background: rgba(13, 110, 253, 0.1); 
                        color: #0d6efd; 
                        border-bottom: 2px solid #0d6efd; 
                    }
                    
                    .tab-content { padding-top: 2rem; }
                    
                    h3, h4 { font-weight: 600; letter-spacing: -0.5px; margin-bottom: 1.5rem; }
                    
                    .table { border-radius: 12px; overflow: hidden; border-collapse: separate; border-spacing: 0; }
                    .table-dark { --bs-table-bg: #141414; border-color: rgba(255, 255, 255, 0.05); }
                    .table th { 
                        background: #1c1c1c; 
                        font-weight: 600; 
                        text-transform: uppercase; 
                        font-size: 0.7rem; 
                        color: #666; 
                        letter-spacing: 1px;
                        padding: 16px;
                        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                    }
                    .table td { padding: 16px; vertical-align: middle; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
                    .table-hover tbody tr:hover { background-color: rgba(255, 255, 255, 0.02); }

                    /* Proxy Config Pills */
                    .home-group {
                        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                    }
                    .home-group:hover tr {
                        background-color: rgba(255, 255, 255, 0.015) !important;
                    }
                    .home-row-main td {
                        border-bottom: none !important;
                    }
                    .home-row-config td {
                        border-top: none !important;
                        padding-top: 0px !important;
                        padding-bottom: 18px !important;
                    }
                    
                    .proxy-pills-container {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 10px;
                        padding-left: 8px;
                        align-items: center;
                    }
                    .proxy-pill {
                        display: inline-flex;
                        align-items: center;
                        background: rgba(255, 255, 255, 0.03);
                        border: 1px solid rgba(255, 255, 255, 0.05);
                        border-radius: 20px;
                        padding: 6px 14px;
                        margin-bottom: 0;
                        transition: all 0.2s ease;
                        gap: 10px;
                    }
                    .proxy-pill:hover {
                        background: rgba(255, 255, 255, 0.08);
                        border-color: rgba(255, 255, 255, 0.15);
                    }
                    .proxy-pill.form-switch {
                        padding-left: 14px;
                    }
                    .proxy-pill.form-switch .form-check-input {
                        cursor: pointer; 
                        border-color: rgba(255, 255, 255, 0.2);
                        background-color: rgba(255, 255, 255, 0.1);
                        width: 2.2em;
                        height: 1.1em;
                        margin-top: 0;
                        margin-left: 0;
                        float: none;
                    }
                    .proxy-pill.form-switch .form-check-input:checked { 
                        background-color: #0d6efd; 
                        border-color: #0d6efd; 
                        box-shadow: 0 0 8px rgba(13, 110, 253, 0.4);
                    }
                    .proxy-pill .form-check-label {
                        font-size: 0.75rem;
                        color: #ccc;
                        cursor: pointer;
                        user-select: none;
                        font-weight: 500;
                        margin-left: 0px;
                    }


                    .btn { font-weight: 500; border-radius: 8px; transition: all 0.2s ease; }
                    .btn-warning { background: #ffc107; border: none; color: #000; }
                    .btn-danger { background: #dc3545; border: none; }
                    .btn-success { background: #198754; border: none; box-shadow: 0 4px 12px rgba(25, 135, 84, 0.3); }
                    .btn-sm { font-size: 0.75rem; padding: 6px 12px; }
                    
                    .badge { font-weight: 500; padding: 6px 10px; border-radius: 6px; }
                    code { color: #0dcaf0; background: rgba(13, 202, 240, 0.1); padding: 2px 6px; border-radius: 4px; }

                    /* Action Buttons Styling */
                    .btn-action-telemetry {
                        background: rgba(13, 202, 240, 0.12);
                        color: #0dcaf0;
                        border: 1px solid rgba(13, 202, 240, 0.4);
                        border-radius: 6px;
                        padding: 4px 10px;
                        font-size: 0.76rem;
                        font-weight: 500;
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                        white-space: nowrap;
                        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                        cursor: pointer;
                        text-decoration: none;
                    }
                    .btn-action-telemetry:hover:not(:disabled) {
                        background: #0dcaf0;
                        color: #051b24;
                        border-color: #0dcaf0;
                        box-shadow: 0 0 10px rgba(13, 202, 240, 0.4);
                        transform: translateY(-1px);
                    }
                    .btn-action-telemetry:active:not(:disabled) { transform: translateY(0); }
                    .btn-action-telemetry:disabled { opacity: 0.6; cursor: not-allowed; }

                    .btn-action-danger {
                        background: rgba(220, 53, 69, 0.12);
                        color: #ea868f;
                        border: 1px solid rgba(220, 53, 69, 0.4);
                        border-radius: 6px;
                        padding: 4px 8px;
                        font-size: 0.76rem;
                        font-weight: 500;
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        white-space: nowrap;
                        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                        cursor: pointer;
                    }
                    .btn-action-danger:hover:not(:disabled) {
                        background: #dc3545;
                        color: #fff;
                        border-color: #dc3545;
                        box-shadow: 0 0 10px rgba(220, 53, 69, 0.4);
                        transform: translateY(-1px);
                    }

                    .btn-action-warning {
                        background: rgba(255, 193, 7, 0.12);
                        color: #ffda6a;
                        border: 1px solid rgba(255, 193, 7, 0.4);
                        border-radius: 6px;
                        padding: 4px 10px;
                        font-size: 0.76rem;
                        font-weight: 500;
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                        white-space: nowrap;
                        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                        cursor: pointer;
                    }
                    .btn-action-warning:hover:not(:disabled) {
                        background: #ffc107;
                        color: #1a1500;
                        border-color: #ffc107;
                        box-shadow: 0 0 10px rgba(255, 193, 7, 0.4);
                        transform: translateY(-1px);
                    }

                    .table-actions-cell {
                        white-space: nowrap;
                        text-align: right;
                        padding-right: 12px !important;
                    }
                    
                    .form-select-sm { background-color: #1a1a1a !important; border-color: rgba(255, 255, 255, 0.1) !important; color: #fff !important; }
                    .font-monospace { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace !important; }
                    pre { background: #000; padding: 15px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); }
                </style>
            </head>
            <body>
                <nav class="navbar navbar-dark bg-primary px-4 mb-4">
                    <div class="d-flex align-items-center">
                        <span class="navbar-brand" data-i18n="nav.portal_title">TaNoClo Setup Portal</span>
                        <a href="/api/docs" target="_blank" class="nav-link text-light ms-3 small" style="text-decoration: underline;" data-i18n="nav.api_reference">API Reference</a>
                    </div>
                    <div class="d-flex align-items-center gap-2">
                        ${renderLanguageSelector(currentLocale, 'portal-lang-select')}
                        <a href="/setup/logout" class="btn btn-outline-light btn-sm" data-i18n="nav.logout">Logout</a>
                    </div>
                </nav>
                <div class="container pb-5">
                    <ul class="nav nav-tabs mb-4" id="setupTabs" role="tablist">
                        <li class="nav-item"><button class="nav-link active" id="tab-homes" data-bs-toggle="tab" data-bs-target="#homes" data-i18n="tabs.homes">Homes</button></li>
                        <li class="nav-item" style="display: none;"><button class="nav-link" id="tab-devices" data-bs-toggle="tab" data-bs-target="#devices" data-i18n="tabs.devices">Devices</button></li>
                        <li class="nav-item" style="display: none;"><button class="nav-link" id="tab-zones" data-bs-toggle="tab" data-bs-target="#zones" data-i18n="tabs.zones">Zones</button></li>
                        <li class="nav-item" style="display: none;"><button class="nav-link" id="tab-tuning" data-bs-toggle="tab" data-bs-target="#tuning" data-i18n="tabs.tuning">Actuator Limits</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-whitelist" data-bs-toggle="tab" data-bs-target="#whitelist" data-i18n="tabs.whitelist">Whitelist</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-users" data-bs-toggle="tab" data-bs-target="#users" data-i18n="tabs.users">Users</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-security" data-bs-toggle="tab" data-bs-target="#security" data-i18n="tabs.security">Security</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-decoder" data-bs-toggle="tab" data-bs-target="#decoder" data-i18n="tabs.decoder">Decoder</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-settings" data-bs-toggle="tab" data-bs-target="#settings" data-i18n="tabs.settings">Settings</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-emulated" data-bs-toggle="tab" data-bs-target="#emulated" data-i18n="tabs.emulated">Emulated Devices</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-snapshot" data-bs-toggle="tab" data-bs-target="#snapshot" data-i18n="tabs.snapshot">State Snapshot</button></li>
                    </ul>

                    <div class="tab-content">
                        <!-- Homes Tab -->
                        <div class="tab-pane fade show active" id="homes">
                            <h3 data-i18n="homes.title">Managed Homes</h3>
                            <table class="table table-dark mt-3">
                                <thead><tr>
                                    <th data-i18n="homes.col_id">ID</th>
                                    <th data-i18n="homes.col_name">Name</th>
                                    <th data-i18n="homes.col_devices">Devices</th>
                                    <th data-i18n="homes.col_ib_serial">IB Serial</th>
                                    <th data-i18n="homes.col_admin_user">Admin User</th>
                                    <th data-i18n="homes.col_actions">Actions</th>
                                </tr></thead>
                                    ${homes.map(h => {
            const homeUsers = users.filter(u => {
                if (u.home_ids === null || u.home_ids === undefined) return false;
                return String(u.home_ids) === String(h.id);
            });
            const options = homeUsers.map(u => `
                                            <option value="${u.id}" ${String(u.id) === String(h.admin_user_id) ? 'selected' : ''}>
                                                ${u.name} (${u.email})
                                            </option>
                                        `).join('');
            return `
                                    <tbody class="home-group">
                                        <tr class="home-row-main">
                                            <td>${h.id}</td>
                                            <td><strong>${h.name}</strong></td>
                                            <td>${h.device_count} (${h.zone_count} <span data-i18n="homes.zones_count">Zones</span>)</td>
                                            <td>
                                                ${h.ib_serial || '-'}
                                                ${h.ib_serial ? `<button class="btn btn-sm btn-outline-success ms-1 py-0 px-1" title="Add to Whitelist" data-i18n-title="homes.add_whitelist_title" onclick="addToWhitelist('device', '${h.ib_serial}')">+</button>` : ''}
                                            </td>
                                            <td>
                                                <select onchange="changeHomeAdmin(${h.id}, this.value)" class="form-select form-select-sm bg-dark text-white border-secondary">
                                                    ${options || '<option value="" data-i18n="homes.no_users">No Users</option>'}
                                                </select>
                                            </td>
                                            <td>
                                                <button class="btn btn-warning btn-sm" onclick="resetHome(${h.id})" data-i18n="common.reset">Reset</button>
                                                <button class="btn btn-danger btn-sm" onclick="deleteHome(${h.id})" data-i18n="common.del">Del</button>
                                            </td>
                                        </tr>
                                        <tr class="home-row-config">
                                            <td colspan="6">
                                                <div class="proxy-pills-container">
                                                    <div class="form-switch proxy-pill">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="proxy_${h.id}" ${h.is_proxied ? 'checked' : ''} onchange="toggleProxy(${h.id}, this.checked ? 1 : 0)">
                                                        <label class="form-check-label" for="proxy_${h.id}" data-i18n="homes.proxy_to_cloud">Proxy to Cloud</label>
                                                    </div>
                                                    <div class="form-switch proxy-pill ${!h.is_proxied ? 'opacity-50' : ''}">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="log_${h.id}" ${h.proxy_logging ? 'checked' : ''} onchange="toggleProxyLog(${h.id}, this.checked ? 1 : 0)" ${!h.is_proxied ? 'disabled' : ''}>
                                                        <label class="form-check-label" for="log_${h.id}" data-i18n="homes.traffic_logging">Traffic Logging</label>
                                                    </div>
                                                    <div class="form-switch proxy-pill ${!h.is_proxied ? 'opacity-50' : ''}">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="allow_cmds_${h.id}" ${h.allow_commands_in_proxy ? 'checked' : ''} onchange="toggleCommandsInProxy(${h.id}, this.checked ? 1 : 0)" ${!h.is_proxied ? 'disabled' : ''}>
                                                        <label class="form-check-label" for="allow_cmds_${h.id}" data-i18n="homes.commands_in_proxy">Commands in Proxy</label>
                                                    </div>
                                                    <div class="form-switch proxy-pill">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="zcro_${h.id}" ${h.zone_config_readonly ? 'checked' : ''} onchange="toggleZoneConfigReadonly(${h.id}, this.checked ? 1 : 0)">
                                                        <label class="form-check-label" for="zcro_${h.id}" data-i18n="homes.config_readonly">Config Readonly</label>
                                                    </div>
                                                    <div class="form-switch proxy-pill">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="ha_${h.id}" ${h.ha_discovery_enabled ? 'checked' : ''} onchange="toggleHaDiscovery(${h.id}, this.checked ? 1 : 0)">
                                                        <label class="form-check-label" for="ha_${h.id}" data-i18n="homes.ha_discovery">HA Discovery</label>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    </tbody>
                                        `;
        }).join('')}
                            </table>

                            <div class="mt-4 border-top pt-4">
                                <h4 data-i18n="homes.seed_title">Seed from Tado</h4>
                                <button class="btn btn-success px-4" onclick="startSeeding()" data-i18n="homes.seed_button">Start Tado Import</button>
                                <div id="seedStatus" class="mt-2"></div>
                            </div>
                        </div>

                        <!-- Devices Tab -->
                        <div class="tab-pane fade" id="devices">
                            <h3 data-i18n="devices.title">Devices & Battery Health</h3>
                            <table class="table table-dark table-hover mt-3">
                                <thead><tr>
                                    <th data-i18n="devices.col_serial">Serial</th>
                                    <th data-i18n="devices.col_type">Type</th>
                                    <th data-i18n="devices.col_home">Home</th>
                                    <th data-i18n="devices.col_battery">Battery</th>
                                    <th data-i18n="devices.col_chemistry">Chemistry</th>
                                    <th data-i18n="devices.col_firmware">Firmware</th>
                                </tr></thead>
                                <tbody>
                                    ${devices.map(d => `
                                        <tr>
                                            <td>${d.serial_no}</td>
                                            <td><span class="badge bg-secondary">${d.device_type}</span></td>
                                            <td>${d.home_name || '-'}</td>
                                            <td>
                                                ${d.battery_percent !== null ? `
                                                    <strong>${d.battery_percent}%</strong> 
                                                    (<span style="color: ${d.battery_state === 'NORMAL' ? 'green' : (d.battery_state === 'LOW' ? 'orange' : 'red')}">${d.battery_state}</span>)
                                                ` : '<span style="color: #666" data-i18n="common.unknown">Unknown</span>'}
                                            </td>
                                            <td>
                                                <select onchange="updateBatteryType('${d.serial_no}', this.value)" class="form-select form-select-sm bg-dark text-white border-secondary">
                                                    <option value="alkaline" ${d.battery_type === 'alkaline' ? 'selected' : ''} data-i18n="devices.alkaline">Alkaline</option>
                                                    <option value="nimh" ${d.battery_type === 'nimh' ? 'selected' : ''} data-i18n="devices.nimh">NiMH</option>
                                                </select>
                                            </td>
                                            <td><code>${d.current_fw_version || '0.0'}</code></td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>

                        <!-- Zones Tab -->
                        <div class="tab-pane fade" id="zones">
                            <h3 data-i18n="zones.title">Zone Management &amp; Offline Schedule</h3>
                            <p class="small text-white-50 mb-3" data-i18n="zones.description">Enable or disable the VA offline (fallback) schedule per zone, and sync the current online schedule to the device&rsquo;s local storage.</p>
                            <div id="zones-loading" class="text-center py-4">
                                <div class="spinner-border text-primary" role="status"><span class="visually-hidden" data-i18n="common.loading">Loading...</span></div>
                            </div>
                            <table class="table table-dark table-hover mt-3" id="zones-table" style="display:none;">
                                <thead><tr>
                                    <th data-i18n="zones.col_zone">Zone</th>
                                    <th data-i18n="zones.col_type">Type</th>
                                    <th data-i18n="zones.col_va_devices">VA Devices</th>
                                    <th data-i18n="zones.col_timetable">Timetable</th>
                                    <th data-i18n="zones.col_offline_schedule">Offline Schedule</th>
                                    <th data-i18n="zones.col_last_synced">Last Synced</th>
                                    <th data-i18n="zones.col_actions">Actions</th>
                                </tr></thead>
                                <tbody id="zones-table-body"></tbody>
                            </table>
                            <div id="zones-empty" class="text-white-50 text-center py-3" style="display:none;" data-i18n="zones.empty">No heating zones with VA devices found.</div>
                        </div>

                        <!-- Actuator Limits Tab -->
                        <div class="tab-pane fade" id="tuning">
                            <h3 data-i18n="tuning.title">Actuator Limits</h3>
                            <p class="small text-white-50 mb-4" data-i18n="tuning.description">
                                Configure mechanical actuator travel limits for Valve Actuators.
                            </p>

                            <div class="row g-4">
                                <!-- Device Actuator limits -->
                                <div class="col-12">
                                    <div class="card bg-dark border-secondary p-4">
                                        <h4 class="text-white" data-i18n="tuning.card_title">Valve Actuator Limits (/d/act)</h4>
                                        <p class="small text-white-50" data-i18n="tuning.card_desc">
                                            Manually override stepper motor limits. 
                                            Fully Extended (Closed) steps define when the valve pin is completely pressed down. 
                                            Fully Retracted (Open) steps set the travel span. Drive Constant acts as mechanical correction.
                                        </p>
                                        <div id="tuning-devices-loading" class="text-center py-3">
                                            <div class="spinner-border text-primary" role="status"><span class="visually-hidden" data-i18n="common.loading">Loading...</span></div>
                                        </div>
                                        <div id="tuning-devices-container" style="display:none;">
                                            <table class="table table-dark table-hover align-middle">
                                                <thead>
                                                    <tr>
                                                        <th data-i18n="tuning.col_device">Device (VA)</th>
                                                        <th data-i18n="tuning.col_home">Home</th>
                                                        <th data-i18n="tuning.col_limit_low">Fully Extended (Limit Low)</th>
                                                        <th data-i18n="tuning.col_limit_high">Fully Retracted (Limit High)</th>
                                                        <th data-i18n="tuning.col_drive_const">Drive Constant</th>
                                                        <th data-i18n="tuning.col_position">Current Position</th>
                                                        <th data-i18n="tuning.col_diagnostics">Diagnostics</th>
                                                        <th data-i18n="tuning.col_action">Action</th>
                                                    </tr>
                                                </thead>
                                                <tbody id="tuning-devices-tbody"></tbody>
                                            </table>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- Instructions -->
                            <div class="card bg-dark border-info p-4 mt-4">
                                <h5 class="text-info" data-i18n="tuning.instructions_title">Actuator Limits Instructions</h5>
                                <div class="small text-white-50">
                                    <h6 data-i18n="tuning.instructions_sub">Actuator Mechanical Travel Tuning:</h6>
                                    <ul>
                                        <li><b>Fully Extended (Limit Low):</b> <span data-i18n="tuning.inst_ext">The step count where the pin is pushed out as far as possible (valve closed). Typical values for VA02 are <b>2100-2600 steps</b>. Increasing this value drives the piston further out (closes tighter).</span></li>
                                        <li><b>Fully Retracted (Limit High):</b> <span data-i18n="tuning.inst_ret">The step count where the piston is retracted as far as possible (valve open). Typical values for VA02 are <b>1900-2500 steps</b>.</span></li>
                                        <li><b>Calibration Drive Constant:</b> <span data-i18n="tuning.inst_cal">An internal calibration reference value representing the baseline calibration offset. Typical values are <b>1700-1900 steps</b>.</span></li>
                                    </ul>
                                </div>
                            </div>
                        </div>

                        <!-- Whitelist Tab -->
                        <div class="tab-pane fade" id="whitelist">
                            <h3 data-i18n="whitelist.title">WebSocket Whitelist</h3>
                            <div class="card bg-dark border-secondary p-3 mb-3 mt-3">
                                <h5 class="text-white small mb-2" data-i18n="whitelist.add_title">Add New Whitelist Entry</h5>
                                <form onsubmit="submitWhitelist(event)" class="row g-2 align-items-end">
                                    <div class="col-md-3">
                                        <label class="form-label small text-info mb-1" data-i18n="whitelist.type_label">Type</label>
                                        <select id="wl_type" class="form-select form-select-sm bg-dark text-white border-secondary">
                                            <option value="home">home</option>
                                            <option value="device">device</option>
                                        </select>
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label small text-info mb-1" data-i18n="whitelist.value_label">Value (Home ID / Bridge Serial)</label>
                                        <input type="text" id="wl_value" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="e.g. 123456 or IB1234567890" data-i18n-placeholder="whitelist.value_placeholder" required autocomplete="off">
                                    </div>
                                    <div class="col-md-3">
                                        <button type="submit" class="btn btn-primary btn-sm w-100" data-i18n="whitelist.btn_add">Add Entry</button>
                                    </div>
                                </form>
                            </div>
                            <table class="table table-dark table-hover mt-3">
                                <thead><tr>
                                    <th data-i18n="whitelist.col_id">ID</th>
                                    <th data-i18n="whitelist.col_type">Type</th>
                                    <th data-i18n="whitelist.col_value">Value</th>
                                    <th data-i18n="whitelist.col_actions">Actions</th>
                                </tr></thead>
                                <tbody>
                                    ${whitelist.map(w => `
                                        <tr>
                                            <td>${w.id}</td>
                                            <td>${w.type}</td>
                                            <td><code>${w.value}</code></td>
                                            <td>
                                                <button class="btn btn-danger btn-sm" onclick="removeFromWhitelist(${w.id})" data-i18n="whitelist.btn_remove">Remove</button>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>

                        <!-- Users Tab -->
                        <div class="tab-pane fade" id="users">
                            <h3 data-i18n="users.title">User Management</h3>
                            <div class="card bg-dark border-secondary p-3 mb-3 mt-3">
                                <h5 class="text-white small mb-2" data-i18n="users.add_title">Add New User to Home</h5>
                                <form onsubmit="submitAddUser(event)" class="row g-2 align-items-end">
                                    <div class="col-md-2">
                                        <label class="form-label small text-info mb-1" data-i18n="users.target_home">Target Home</label>
                                        <select id="user_home_id" class="form-select form-select-sm bg-dark text-white border-secondary" required>
                                            <option value="" data-i18n="users.select_home">Select Home...</option>
                                            ${homes.map(h => `<option value="${h.id}">${h.name} (#${h.id})</option>`).join('')}
                                        </select>
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label small text-info mb-1" data-i18n="users.full_name">Full Name</label>
                                        <input type="text" id="user_name" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="Jane Doe" required autocomplete="off">
                                    </div>
                                    <div class="col-md-3">
                                        <label class="form-label small text-info mb-1" data-i18n="users.email_user">Email / Username</label>
                                        <input type="email" id="user_email" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="user@example.com" required autocomplete="off">
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label small text-info mb-1" data-i18n="users.password">Password</label>
                                        <input type="password" id="user_password" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="Password" data-i18n-placeholder="users.password" required autocomplete="new-password">
                                    </div>
                                    <div class="col-md-3">
                                        <div class="d-flex gap-3 mb-2">
                                            <div class="form-check form-check-inline mb-0">
                                                <input class="form-check-input" type="checkbox" id="user_is_primary_admin">
                                                <label class="form-check-label small text-white-50" for="user_is_primary_admin" title="Designate as primary Home Admin" data-i18n="users.primary_admin">Primary Admin</label>
                                            </div>
                                            <div class="form-check form-check-inline mb-0">
                                                <input class="form-check-input" type="checkbox" id="user_is_tanoclo_admin">
                                                <label class="form-check-label small text-white-50" for="user_is_tanoclo_admin" title="Grants TaNoClo Admin capabilities" data-i18n="users.tanoclo_admin">TaNoClo Admin</label>
                                            </div>
                                        </div>
                                        <button type="submit" class="btn btn-primary btn-sm w-100" data-i18n="users.btn_add_user">+ Add User</button>
                                    </div>
                                </form>
                            </div>
                            <table class="table table-dark table-hover mt-3 align-middle">
                                <thead><tr>
                                    <th data-i18n="users.col_id">ID</th>
                                    <th data-i18n="users.col_name">Name</th>
                                    <th data-i18n="users.col_email">Email / Username</th>
                                    <th data-i18n="users.col_home">Home</th>
                                    <th data-i18n="users.col_role">Role</th>
                                    <th data-i18n="users.col_actions">Actions</th>
                                </tr></thead>
                                <tbody>
                                    ${users.map(u => `
                                        <tr>
                                            <td><small class="text-white-50">${u.id}</small></td>
                                            <td><strong class="text-white">${u.name}</strong></td>
                                            <td>${u.email}</td>
                                            <td>${u.home_name ? u.home_name + ' <span class="text-white-50">(#' + u.home_id + ')</span>' : (u.home_id ? '#' + u.home_id : '-')}</td>
                                            <td>
                                                ${u.is_primary_admin ? '<span class="badge bg-primary text-white me-1" data-i18n="users.role_primary_admin">Primary Admin</span>' : ''}
                                                ${u.is_tanoclo_admin ? '<span class="badge bg-info text-dark me-1" data-i18n="users.role_tanoclo_admin">TaNoClo Admin</span>' : ''}
                                                ${!u.is_primary_admin && !u.is_tanoclo_admin ? '<span class="badge bg-secondary text-white" data-i18n="users.role_member">Member</span>' : ''}
                                            </td>
                                            <td>
                                                <button class="btn btn-sm btn-outline-warning" onclick="resetUserPass('${u.id}')" title="Reset Password">Pwd</button>
                                                <button class="btn btn-sm btn-outline-info" onclick="changeUserEmail('${u.id}')" title="Change Email">Mail</button>
                                                <button class="btn btn-sm btn-outline-danger" onclick="deleteUser('${u.id}')" title="Delete User">Del</button>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>

                        <!-- Security Tab -->
                        <div class="tab-pane fade" id="security">
                            <div class="row">
                                <div class="col-md-6">
                                    <div class="card bg-dark border-secondary p-4 h-100">
                                        <h4 class="text-white" data-i18n="security.change_pass_title">Change Admin Password</h4>
                                        <p class="small text-white-50" data-i18n="security.change_pass_desc">Requires your current password and 2FA code (if enabled).</p>
                                        <!-- Hidden username field to help autofill engines -->
                                        <input type="text" name="username" value="${admin.username}" style="display:none;" autocomplete="username">
                                        <div class="mb-3">
                                            <label class="form-label small text-info" data-i18n="security.current_pass">Current Password</label>
                                            <input type="password" id="admin_current_pass" class="form-control bg-dark text-white border-secondary" autocomplete="current-password" placeholder="Enter current password" data-i18n-placeholder="security.current_pass_placeholder">
                                        </div>
                                        <div class="mb-3">
                                            <label class="form-label small text-info" data-i18n="security.new_pass">New Password</label>
                                            <input type="password" id="admin_new_pass" class="form-control bg-dark text-white border-secondary" autocomplete="new-password" placeholder="Enter new password" data-i18n-placeholder="security.new_pass_placeholder">
                                        </div>
                                        ${admin.totp_secret ? `
                                        <div class="mb-3">
                                            <label class="form-label small text-info" data-i18n="security.current_2fa">Current 2FA Code</label>
                                            <input type="text" id="admin_pass_totp" class="form-control bg-dark text-white border-secondary" placeholder="6-digit code" data-i18n-placeholder="security.current_2fa_placeholder" maxlength="6" autocomplete="one-time-code">
                                        </div>
                                        ` : ''}
                                        <button class="btn btn-primary" onclick="updateAdminPass(${admin.totp_secret ? 'true' : 'false'})" data-i18n="security.btn_update_pass">Update Password</button>
                                    </div>
                                </div>
                                <div class="col-md-6">
                                    <div class="card bg-dark border-secondary p-4 h-100">
                                        <h4 class="text-white" data-i18n="security.title_2fa">Two-Factor Authentication (2FA)</h4>
                                        <p class="small text-white-50"><span data-i18n="security.status_label">Current Status:</span> <span class="badge ${admin.totp_secret ? 'bg-success' : 'bg-warning'}" data-i18n="${admin.totp_secret ? 'common.enabled' : 'common.disabled'}">${admin.totp_secret ? 'Enabled' : 'Disabled'}</span></p>
                                        
                                        <div class="mb-3">
                                            <label class="form-label small text-info" data-i18n="security.pass_required">Current Password (Required)</label>
                                            <input type="password" id="admin_totp_current_pass" class="form-control bg-dark text-white border-secondary" autocomplete="current-password" placeholder="Enter current password" data-i18n-placeholder="security.current_pass_placeholder">
                                        </div>
                                        ${admin.totp_secret ? `
                                        <div class="mb-3">
                                            <label class="form-label small text-info" data-i18n="security.code_required">Current 2FA Code (Required)</label>
                                            <input type="text" id="admin_totp_current_code" class="form-control bg-dark text-white border-secondary" placeholder="Current 6-digit 2FA code" maxlength="6" autocomplete="one-time-code">
                                        </div>
                                        ` : ''}
                                        <div class="mb-3">
                                            <label class="form-label small text-info" data-i18n="security.new_secret">New 2FA Secret (Base32)</label>
                                            <div class="input-group">
                                                <input type="text" id="admin_totp_secret" class="form-control bg-dark text-white border-secondary" placeholder="Click 'Gen' or enter a secret" autocomplete="off">
                                                <button class="btn btn-outline-info" onclick="generateTotpSecret()" title="Generate new random secret" data-i18n="security.gen">Gen</button>
                                            </div>
                                            <div class="form-text text-white-50 small mt-2" data-i18n="security.secret_hint">
                                                To set or rotate your 2FA, generate or enter a new Base32 secret and update. 
                                                <strong>Note: Current secret is hidden for privacy.</strong>
                                            </div>
                                        </div>
                                        <div class="mb-3">
                                            <label class="form-label small text-info" data-i18n="security.code_from_new">Code from NEW Secret (to verify)</label>
                                            <input type="text" id="admin_totp_new_code" class="form-control bg-dark text-white border-secondary" placeholder="6-digit code from new secret" maxlength="6" autocomplete="one-time-code">
                                        </div>
                                        <div class="d-flex align-items-center justify-content-between mt-2">
                                            <button class="btn btn-primary" onclick="updateAdminTotp(${admin.totp_secret ? 'true' : 'false'})" data-i18n="security.btn_update_2fa">Update 2FA Secret</button>
                                            ${admin.totp_secret ? `<button class="btn btn-link btn-sm text-danger h6 p-0 mb-0" onclick="disableAdminTotp()" data-i18n="security.btn_disable_2fa">Disable 2FA</button>` : ''}
                                        </div>
                                    </div>
                                </div>
                            </div>
                    </div>

                    <!-- Decoder Tab -->
                    <div class="tab-pane fade" id="decoder">
                        <h3 data-i18n="decoder.title">Message Decoder</h3>
                        <div class="row">
                            <div class="col-12 mb-4">
                                <div class="card bg-dark border-secondary p-4">
                                    <h4 class="text-white" data-i18n="decoder.card_title">Decode WebSocket / CoAP Message</h4>
                                    <p class="small text-white-50" data-i18n="decoder.card_desc">Paste a raw hex message from debug logs to see a detailed breakdown of the Bridge Frame, CoAP layer, and TLV payload.</p>
                                    <div class="mb-3">
                                        <label for="decoder_cache_select" class="form-label small text-info" data-i18n="decoder.load_cache">Load from Cache (Last Downlink)</label>
                                        <div class="input-group">
                                            <select id="decoder_cache_select" class="form-select form-select-sm bg-dark text-white border-secondary">
                                                <option value="" data-i18n="decoder.no_cached">-- No messages cached --</option>
                                            </select>
                                            <button class="btn btn-outline-info btn-sm" onclick="refreshCache()" data-i18n="decoder.refresh">Refresh</button>
                                        </div>
                                    </div>
                                    <div class="mb-3">
                                        <label for="decoder_hex" class="form-label small text-info" data-i18n="decoder.raw_hex">Raw Hex Message</label>
                                        <textarea id="decoder_hex" class="form-control bg-dark text-white border-secondary font-monospace" rows="5" placeholder="000110fd000000000000000000000000000001..."></textarea>
                                    </div>
                                    <button class="btn btn-primary" onclick="decodeHex()" data-i18n="decoder.btn_decode">Decode Message</button>
                                </div>
                            </div>
                        </div>
                        <div id="decoder_results" style="display:none;">
                            <div class="row">
                                <div class="col-md-6 mb-4">
                                    <div id="bridge_card" class="card bg-dark border-info p-3 h-100" style="display:none;">
                                        <h5 class="text-info" data-i18n="decoder.ws_frame">WS Bridge Frame</h5>
                                        <div id="bridge_info" class="small"></div>
                                    </div>
                                </div>
                                <div class="col-md-6 mb-4">
                                    <div id="coap_card" class="card bg-dark border-primary p-3 h-100" style="display:none;">
                                        <h5 class="text-primary" data-i18n="decoder.coap_msg">CoAP Message</h5>
                                        <div id="coap_info" class="small"></div>
                                    </div>
                                </div>
                            </div>
                            <div id="tlv_card" class="card bg-dark border-success p-3 mb-4" style="display:none;">
                                <h5 class="text-success" data-i18n="decoder.tlv_payload">TLV Payload</h5>
                                <div class="table-responsive">
                                    <table class="table table-dark table-sm small mt-2">
                                        <thead><tr>
                                            <th data-i18n="decoder.col_fid">ID</th>
                                            <th data-i18n="decoder.col_tlv_name">Name</th>
                                            <th data-i18n="decoder.col_val">Value</th>
                                            <th data-i18n="decoder.col_unit">Unit</th>
                                            <th data-i18n="decoder.col_raw">Raw</th>
                                        </tr></thead>
                                        <tbody id="tlv_table_body"></tbody>
                                    </table>
                                </div>
                            </div>
                            <div class="card bg-dark border-secondary p-3">
                                <h5 class="text-secondary" data-i18n="decoder.full_json">Full JSON Result</h5>
                                <pre id="decoder_json" class="small text-white-50 mb-0" style="max-height: 300px; overflow: auto;"></pre>
                            </div>
                        </div>
                    </div>

                    <!-- Settings Tab -->
                    <div class="tab-pane fade" id="settings">
                        <div class="row g-4">
                            <!-- Server Settings -->
                            <div class="col-md-6">
                                <div class="card bg-dark border-secondary p-4 h-100">
                                    <h4 class="text-white mb-3" data-i18n="settings.server_title">Server Settings</h4>
                                    <div class="mb-3">
                                        <label class="form-label small text-info" data-i18n="settings.log_level">Log Level</label>
                                        <select id="settings_log_level" class="form-select form-select-sm bg-dark text-white border-secondary">
                                            <option value="debug">debug</option>
                                            <option value="info">info</option>
                                            <option value="warn">warn</option>
                                            <option value="error">error</option>
                                        </select>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info" data-i18n="settings.jwt_secret">JWT Secret</label>
                                        <div class="input-group">
                                            <input type="password" id="settings_jwt_secret" class="form-control bg-dark text-white border-secondary font-monospace" readonly>
                                            <button class="btn btn-outline-secondary btn-sm" onclick="toggleJwtVisibility()" title="Show/Hide" id="jwt_toggle_btn">👁</button>
                                            <button class="btn btn-outline-warning btn-sm" onclick="generateJwtSecret()" title="Generate new">Gen</button>
                                        </div>
                                        <div class="form-text text-white-50 small mt-1" data-i18n="settings.jwt_hint">Changing the JWT secret will invalidate all existing sessions.</div>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info" data-i18n="settings.carto_key">CARTO Basemaps API Key</label>
                                        <div class="input-group">
                                            <input type="password" id="settings_carto_api_key" class="form-control bg-dark text-white border-secondary font-monospace" placeholder="cb1_...">
                                            <button class="btn btn-outline-secondary btn-sm" onclick="toggleCartoKeyVisibility()" title="Show/Hide" id="carto_toggle_btn">👁</button>
                                        </div>
                                        <div class="form-text text-white-50 small mt-1" data-i18n="settings.carto_hint">CARTO API key for raster basemap tiles on geofence maps to remove watermarks.</div>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info" data-i18n="settings.retention_device">Device Measurements Retention (Days)</label>
                                        <input type="number" id="settings_cleanup_device_measurements_days" class="form-control form-control-sm bg-dark text-white border-secondary" min="1" required>
                                        <div class="form-text text-white-50 small mt-1" data-i18n="settings.retention_device_hint">How many days of device measurements to keep. Default: 30.</div>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info" data-i18n="settings.retention_zone">Zone Measurements Retention (Days)</label>
                                        <input type="number" id="settings_cleanup_zone_measurements_days" class="form-control form-control-sm bg-dark text-white border-secondary" min="1" required>
                                        <div class="form-text text-white-50 small mt-1" data-i18n="settings.retention_zone_hint">How many days of zone measurements to keep. Default: 390 (13 months).</div>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info" data-i18n="settings.retention_circuit">Circuit Measurements Retention (Days)</label>
                                        <input type="number" id="settings_cleanup_circuit_measurements_days" class="form-control form-control-sm bg-dark text-white border-secondary" min="1" required>
                                        <div class="form-text text-white-50 small mt-1" data-i18n="settings.retention_circuit_hint">How many days of circuit measurements to keep. Default: 390 (13 months).</div>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info" data-i18n="settings.retention_weather">Home Weather Retention (Days)</label>
                                        <input type="number" id="settings_cleanup_home_weather_days" class="form-control form-control-sm bg-dark text-white border-secondary" min="1" required>
                                        <div class="form-text text-white-50 small mt-1" data-i18n="settings.retention_weather_hint">How many days of home weather data to keep. Default: 390 (13 months).</div>
                                    </div>
                                    <div class="form-check form-switch mb-3">
                                        <input class="form-check-input" type="checkbox" role="switch" id="settings_swagger_enabled">
                                        <label class="form-check-label small text-info" for="settings_swagger_enabled" data-i18n="settings.swagger_enabled">Enable OpenAPI/Swagger Documentation</label>
                                        <div class="form-text text-white-50 small mt-1" data-i18n="settings.swagger_hint">Make interactive Swagger docs available at /api/docs (guarded by setup admin authentication).</div>
                                    </div>
                                    <div class="d-flex gap-2 mb-2">
                                        <button class="btn btn-primary btn-sm" onclick="saveServerSettings()" data-i18n="settings.btn_save_settings">Save Settings</button>
                                    </div>
                                </div>
                            </div>

                            <!-- Right Column: MQTT Configuration, Frontend OTA Updates, Server Control -->
                            <div class="col-md-6">
                                <!-- MQTT Configuration -->
                                <div class="card bg-dark border-secondary p-4 mb-4">
                                    <h4 class="text-white mb-3" data-i18n="settings.mqtt_title">MQTT Configuration</h4>
                                    <div class="row g-2 mb-2">
                                        <div class="col-8">
                                            <label class="form-label small text-info" data-i18n="settings.broker_host">Broker Host</label>
                                            <input type="text" id="mqtt_host" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="e.g. 192.168.1.100">
                                        </div>
                                        <div class="col-4">
                                            <label class="form-label small text-info" data-i18n="settings.broker_port">Port</label>
                                            <input type="number" id="mqtt_port" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="1883" value="1883">
                                        </div>
                                    </div>
                                    <div class="row g-2 mb-2">
                                        <div class="col-6">
                                            <label class="form-label small text-info" data-i18n="settings.broker_user">Username</label>
                                            <input type="text" id="mqtt_user" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="mqtt_user">
                                        </div>
                                        <div class="col-6">
                                            <label class="form-label small text-info" data-i18n="settings.broker_pass">Password</label>
                                            <input type="password" id="mqtt_password" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="••••••">
                                        </div>
                                    </div>
                                    <div class="form-check form-switch d-flex justify-content-between align-items-center px-0 my-3 py-2 px-2 rounded" style="background: rgba(255,255,255,0.03);">
                                        <label class="form-check-label small text-white" for="mqtt_ha_discovery" data-i18n="settings.ha_discovery">Home Assistant Discovery</label>
                                        <input class="form-check-input ms-0" type="checkbox" role="switch" id="mqtt_ha_discovery">
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info" data-i18n="settings.ha_mqtt_path">HA MQTT Path</label>
                                        <input type="text" id="mqtt_ha_path" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="homeassistant" value="homeassistant">
                                    </div>
                                    <div class="d-flex gap-2">
                                        <button class="btn btn-primary btn-sm" onclick="saveMqttSettings()" data-i18n="settings.btn_save_mqtt">Save MQTT</button>
                                        <button class="btn btn-outline-info btn-sm" id="mqtt_test_btn" onclick="testMqttConnection()" data-i18n="settings.btn_test_conn">Test Connection</button>
                                    </div>
                                    <div id="mqtt_status" class="mt-2 small"></div>
                                </div>

                                <!-- Frontend OTA Updates -->
                                <div class="card bg-dark border-secondary p-4 mb-4">
                                    <h4 class="text-white mb-3" data-i18n="settings.ota_title">Frontend OTA Updates</h4>
                                    <div class="form-check form-switch mb-3">
                                        <input class="form-check-input" type="checkbox" role="switch" id="settings_ota_auto_update">
                                        <label class="form-check-label small text-info" for="settings_ota_auto_update" data-i18n="settings.ota_auto">Auto-update Frontend</label>
                                        <div class="form-text text-white-50 small mt-1" data-i18n="settings.ota_hint">Automatically download and extract the latest frontend web assets from the GitHub OTA branch on startup and hourly. If disabled, existing frontend files are kept. Overruled once if no frontend files exist.</div>
                                    </div>
                                    <div class="d-flex gap-2 align-items-center">
                                        <button class="btn btn-outline-info btn-sm" id="ota_sync_btn" onclick="triggerOtaSync()" data-i18n="settings.ota_sync_now">⟳ Sync Frontend Now</button>
                                        <span id="ota_sync_status" class="small"></span>
                                    </div>
                                </div>

                                <!-- Server Control -->
                                <div class="card bg-dark border-secondary p-4">
                                    <h4 class="text-white mb-3" data-i18n="settings.server_control_title">Server Control</h4>
                                    <p class="small text-white-50 mb-2" data-i18n="settings.server_control_desc">Restart the Node.js server. Docker will automatically restart the container. All WebSocket connections will be dropped and IB devices will reconnect.</p>
                                    <button class="btn btn-danger btn-sm" id="restart_btn" onclick="restartServer()" data-i18n="settings.btn_restart">⟳ Restart Server</button>
                                    <div id="restart_status" class="mt-2 small"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- State Snapshot Tab -->
                    <div class="tab-pane fade" id="snapshot">
                        <h3 data-i18n="snapshot.title">State Snapshot</h3>
                        <p class="small text-white-50 mb-3" data-i18n="snapshot.description">
                            Capture original Tado cloud configuration while in proxy mode.
                            Use snapshots to revert devices, zones, and circuits to their original state after making changes in TaNoClo.
                        </p>

                        <!-- Home Selector + Capture Controls -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <div class="row align-items-end g-3">
                                <div class="col-md-4">
                                    <label class="form-label small text-info" data-i18n="snapshot.home_label">Home</label>
                                    <select id="snap_home" class="form-select form-select-sm bg-dark text-white border-secondary" onchange="loadSnapshotData()">
                                        ${homes.map(h => '<option value="' + h.id + '">' + h.name + ' (' + h.id + ')</option>').join('')}
                                    </select>
                                </div>
                                <div class="col-md-8 d-flex gap-2">
                                    <button class="btn btn-success btn-sm" id="snap_start_btn" onclick="startSnapshotCapture()" data-i18n="snapshot.btn_start_capture">▶ Start Capture</button>
                                    <button class="btn btn-warning btn-sm" id="snap_stop_btn" onclick="stopSnapshotCapture()" disabled data-i18n="snapshot.btn_stop_capture">⏹ Stop Capture</button>
                                    <span id="snap_status" class="badge bg-secondary align-self-center ms-2" data-i18n="snapshot.status_not_started">Not Started</span>
                                </div>
                            </div>
                        </div>

                        <!-- Progress Matrix -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <h5 class="text-white mb-2" data-i18n="snapshot.progress_title">Capture Progress</h5>
                            <div class="progress mb-3" style="height: 8px;">
                                <div class="progress-bar bg-success" id="snap_progress_bar" style="width: 0%"></div>
                            </div>
                            <div class="small text-white-50 mb-3" id="snap_progress_text" data-i18n="snapshot.no_capture">No capture active</div>
                            <div class="table-responsive">
                                <table class="table table-dark table-hover table-sm" id="snap_progress_table" style="display:none;">
                                    <thead><tr>
                                        <th data-i18n="snapshot.col_entity">Entity</th>
                                        <th data-i18n="snapshot.col_type">Type</th>
                                        <th data-i18n="snapshot.col_path">Path</th>
                                        <th data-i18n="snapshot.col_status">Status</th>
                                        <th data-i18n="snapshot.col_captured">Captured</th>
                                    </tr></thead>
                                    <tbody id="snap_progress_tbody"></tbody>
                                </table>
                            </div>
                        </div>

                        <!-- Snapshot History -->
                        <div class="card bg-dark border-secondary p-3">
                            <h5 class="text-white mb-2" data-i18n="snapshot.history_title">Snapshot History</h5>
                            <div id="snap_history_loading" class="text-center py-2">
                                <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
                            </div>
                            <div class="table-responsive">
                                <table class="table table-dark table-hover table-sm" id="snap_history_table" style="display:none;">
                                    <thead><tr>
                                        <th data-i18n="snapshot.col_id">ID</th>
                                        <th data-i18n="snapshot.col_created">Created</th>
                                        <th data-i18n="common.status">Status</th>
                                        <th data-i18n="snapshot.col_size">Size</th>
                                        <th data-i18n="snapshot.col_actions">Actions</th>
                                    </tr></thead>
                                    <tbody id="snap_history_tbody"></tbody>
                                </table>
                            </div>
                            <div class="mt-3 border-top border-secondary pt-3">
                                <h6 class="text-white-50 small" data-i18n="snapshot.import_title">Import Snapshot</h6>
                                <div class="input-group input-group-sm">
                                    <input type="file" class="form-control form-control-sm bg-dark text-white border-secondary" id="snap_import_file" accept=".json">
                                    <button class="btn btn-outline-info btn-sm" onclick="importSnapshot()" data-i18n="snapshot.btn_import">Import</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Emulated Devices & ESP32 Nodes Tab -->
                    <div class="tab-pane fade" id="emulated">
                        <div class="d-flex justify-content-between align-items-center mb-3">
                            <div>
                                <h3 data-i18n="emulated.title">Emulated Devices &amp; ESP32 Nodes</h3>
                                <p class="small text-white-50 mb-0" data-i18n="emulated.description">Manage hardware ESP32 host nodes and emulated Tado Room Units (RU) in Wireless Temperature Sensor mode.</p>
                            </div>
                            <button class="btn btn-outline-info btn-sm" onclick="loadEmulatedData()" data-i18n="emulated.btn_refresh">🔄 Refresh List</button>
                        </div>

                        <!-- Register ESP32 Hardware Node Card -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <h5 class="text-info" data-i18n="emulated.reg_node_title">Register ESP32 Hardware Node</h5>
                            <div class="row g-2 align-items-end">
                                <div class="col-md-3">
                                    <label class="form-label small text-white-50" data-i18n="emulated.node_name">Node Name</label>
                                    <input type="text" id="emul_node_name" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="ESP32 Sniffer/Emulator 1">
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label small text-white-50" data-i18n="emulated.node_ip">IP Address</label>
                                    <input type="text" id="emul_node_ip" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="192.168.1.150">
                                </div>
                                <div class="col-md-2">
                                    <label class="form-label small text-white-50" data-i18n="emulated.api_port">API Port</label>
                                    <input type="number" id="emul_node_port" class="form-control form-control-sm bg-dark text-white border-secondary" value="80">
                                </div>
                                <div class="col-md-2">
                                    <label class="form-label small text-white-50" data-i18n="emulated.api_key_optional">API Key (Optional)</label>
                                    <input type="text" id="emul_node_key" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="From yaml">
                                </div>
                                <div class="col-md-2">
                                    <button class="btn btn-primary btn-sm w-100" onclick="addEsp32Node()" data-i18n="emulated.btn_add_node">+ Add Node</button>
                                </div>
                            </div>
                        </div>

                        <!-- ESP32 Hardware Nodes Table -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <h5 class="text-white" data-i18n="emulated.active_nodes_title">Active ESP32 Nodes</h5>
                            <div class="table-responsive">
                                <table class="table table-dark table-sm small align-middle mb-0">
                                    <thead><tr>
                                        <th data-i18n="emulated.col_id">ID</th>
                                        <th data-i18n="emulated.col_node_name">Node Name</th>
                                        <th data-i18n="emulated.col_ip">IP Address</th>
                                        <th data-i18n="emulated.col_port">Port</th>
                                        <th data-i18n="emulated.col_api_key">API Key</th>
                                        <th data-i18n="emulated.col_status">Status</th>
                                        <th data-i18n="emulated.col_last_seen">Last Seen</th>
                                        <th data-i18n="emulated.col_actions">Actions</th>
                                    </tr></thead>
                                    <tbody id="emul_nodes_tbody"><tr><td colspan="8" class="text-white-50">Loading nodes...</td></tr></tbody>
                                </table>
                            </div>
                        </div>

                        <!-- Create Emulated Device Card -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <h5 class="text-success" data-i18n="emulated.create_dev_title">Create Emulated RU Device (Wireless Sensor Mode)</h5>
                            <div class="row g-2 align-items-end">
                                <div class="col-md-3">
                                    <label class="form-label small text-white-50" data-i18n="emulated.target_node">Target ESP32 Node</label>
                                    <select id="emul_dev_node" class="form-select form-select-sm bg-dark text-white border-secondary">
                                        <option value="" data-i18n="emulated.select_node">Select Node...</option>
                                    </select>
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label small text-white-50" data-i18n="emulated.home_assignment">Home Assignment</label>
                                    <select id="emul_dev_home" class="form-select form-select-sm bg-dark text-white border-secondary">
                                        ${homes.map(h => '<option value="' + h.id + '">' + h.name + ' (' + h.id + ')</option>').join('')}
                                    </select>
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label small text-white-50" data-i18n="emulated.serial_optional">Serial Number (Optional)</label>
                                    <input type="text" id="emul_dev_serial" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="Auto-generated if empty" data-i18n-placeholder="emulated.serial_placeholder">
                                </div>
                                <div class="col-md-3">
                                    <button class="btn btn-success btn-sm w-100" onclick="createEmulatedDevice()" data-i18n="emulated.btn_create_dev">+ Create &amp; Auto-Pair</button>
                                </div>
                            </div>
                        </div>

                        <!-- Emulated Devices Table -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <h5 class="text-white" data-i18n="emulated.registry_title">Emulated Devices Registry</h5>
                            <div class="table-responsive">
                                <table class="table table-dark table-sm small align-middle mb-0">
                                    <thead><tr>
                                        <th data-i18n="emulated.col_serial">Serial No</th>
                                        <th data-i18n="emulated.col_esp32_host">ESP32 Host</th>
                                        <th data-i18n="emulated.col_home">Home</th>
                                        <th data-i18n="emulated.col_mode">Mode</th>
                                        <th data-i18n="emulated.col_ipv6">IPv6 Address</th>
                                        <th data-i18n="emulated.col_pairing">Pairing State</th>
                                        <th data-i18n="emulated.col_actions">Actions</th>
                                    </tr></thead>
                                    <tbody id="emul_devs_tbody"><tr><td colspan="7" class="text-white-50">Loading devices...</td></tr></tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>

                <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
                <script>
                    async function apiCall(url, method = 'POST', body = null) {
                        try {
                            const res = await fetch(url, {
                                method,
                                headers: body ? { 'Content-Type': 'application/json' } : {},
                                body: body ? JSON.stringify(body) : null
                            });
                            const text = await res.text();
                            let data;
                            try { data = JSON.parse(text); } catch(e) {}
                            if (!res.ok) {
                                throw new Error((data && data.error) ? data.error : text);
                            }
                            return data;
                        } catch (e) {
                            alert((window.t ? window.t('common.operation_failed', 'Operation failed: ') : 'Operation failed: ') + e.message);
                            return null;
                        }
                    }

                    // Home Actions
                    async function toggleProxy(id, val) { await apiCall('/setup/homes/'+id+'/proxy', 'POST', { enabled: val }); location.reload(); }
                    async function toggleProxyLog(id, val) { await apiCall('/setup/homes/'+id+'/proxy-log', 'POST', { enabled: val }); location.reload(); }
                    async function toggleCommandsInProxy(id, val) { await apiCall('/setup/homes/'+id+'/allow-commands-in-proxy', 'POST', { enabled: val }); location.reload(); }
                    async function toggleZoneConfigReadonly(id, val) { await apiCall('/setup/homes/'+id+'/zone-config-readonly', 'POST', { enabled: val }); location.reload(); }
                    async function toggleDevBypass(id, val) { await apiCall('/setup/homes/'+id+'/dev-bypass', 'POST', { enabled: val }); location.reload(); }
                    async function toggleHaDiscovery(id, val) { await apiCall('/setup/homes/'+id+'/ha-discovery', 'POST', { enabled: val }); location.reload(); }
                    async function resetHome(id) { if(confirm(window.t ? window.t('homes.confirm_reset', 'Reset home config while preserving stats?') : 'Reset home config while preserving stats?')) { await apiCall('/setup/homes/'+id+'/reset'); location.reload(); } }
                    async function deleteHome(id) { if(confirm(window.t ? window.t('homes.confirm_delete', 'DANGER: Fully delete home and ALL measurements?') : 'DANGER: Fully delete home and ALL measurements?')) { await apiCall('/setup/homes/'+id+'/delete'); location.reload(); } }
                    async function changeHomeAdmin(homeId, adminUserId) { 
                        const result = await apiCall('/setup/homes/' + homeId + '/admin', 'POST', { adminUserId }); 
                        if (result && result.success) {
                            alert(window.t ? window.t('homes.admin_updated', 'Home admin updated successfully') : 'Home admin updated successfully');
                        }
                    }

                    // Whitelist Actions
                    async function addToWhitelist(type, value) { await apiCall('/setup/whitelist', 'POST', { type, value }); location.reload(); }
                    async function submitWhitelist(e) {
                        e.preventDefault();
                        const type = document.getElementById('wl_type').value;
                        const value = document.getElementById('wl_value').value.trim();
                        if (type && value) {
                            await addToWhitelist(type, value);
                        }
                    }
                    async function removeFromWhitelist(id) { await apiCall('/setup/whitelist/'+id, 'DELETE'); location.reload(); }

                    // Device Actions
                    async function updateBatteryType(serial, type) { await apiCall('/setup/devices/'+serial+'/battery', 'POST', { type }); }

                    // User Actions
                    async function submitAddUser(event) {
                        event.preventDefault();
                        const home_id = document.getElementById('user_home_id').value;
                        const name = document.getElementById('user_name').value.trim();
                        const email = document.getElementById('user_email').value.trim();
                        const password = document.getElementById('user_password').value;
                        const is_primary_admin = document.getElementById('user_is_primary_admin').checked;
                        const is_tanoclo_admin = document.getElementById('user_is_tanoclo_admin').checked;

                        if (!home_id || !name || !email || !password) {
                            return alert(window.t ? window.t('users.fill_fields', 'Please fill in home, name, email, and password.') : 'Please fill in home, name, email, and password.');
                        }

                        const res = await apiCall('/setup/users', 'POST', {
                            home_id: parseInt(home_id, 10),
                            name,
                            email,
                            password,
                            is_primary_admin,
                            is_tanoclo_admin
                        });

                        if (res && res.success) {
                            alert(window.t ? window.t('users.user_added', 'User successfully added to home!') : 'User successfully added to home!');
                            location.reload();
                        }
                    }
                    async function resetUserPass(id) { const p = prompt(window.t ? window.t('users.prompt_password', 'New Password:') : 'New Password:'); if(p) await apiCall('/setup/users/'+id+'/password', 'POST', { password: p }); }
                    async function changeUserEmail(id) { const e = prompt(window.t ? window.t('users.prompt_email', 'New Email:') : 'New Email:'); if(e) await apiCall('/setup/users/'+id+'/email', 'POST', { email: e }); location.reload(); }
                    async function deleteUser(id) { if(confirm(window.t ? window.t('users.confirm_delete', 'Delete user?') : 'Delete user?')) { await apiCall('/setup/users/'+id, 'DELETE'); location.reload(); } }

                    // Admin Security
                    async function updateAdminPass(hasTotp) {
                        const current_password = document.getElementById('admin_current_pass').value;
                        if (!current_password) return alert(window.t ? window.t('security.current_pass_required', 'Current password is required') : 'Current password is required');

                        const password = document.getElementById('admin_new_pass').value;
                        if (!password) return alert(window.t ? window.t('security.new_pass_required', 'Enter a new password') : 'Enter a new password');
                        
                        let totp = null;
                        if (hasTotp) {
                            const totpInput = document.getElementById('admin_pass_totp');
                            totp = totpInput ? totpInput.value.trim() : null;
                            if (!totp) return alert(window.t ? window.t('security.code_required', 'Current 2FA code is required') : 'Current 2FA code is required');
                        }

                        const data = await apiCall('/setup/admin/password', 'POST', { current_password, password, totp });
                        if (data?.success) {
                            alert(window.t ? window.t('security.pass_updated', 'Password updated!') : 'Password updated!');
                            document.getElementById('admin_current_pass').value = '';
                            document.getElementById('admin_new_pass').value = '';
                            if (document.getElementById('admin_pass_totp')) document.getElementById('admin_pass_totp').value = '';
                        } else if (data?.error) {
                            alert('Error: ' + data.error);
                        }
                    }
                    function generateTotpSecret() {
                        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
                        let secret = '';
                        for (let i = 0; i < 16; i++) secret += chars.charAt(Math.floor(Math.random() * chars.length));
                        document.getElementById('admin_totp_secret').value = secret;
                        alert((window.t ? window.t('security.new_secret_gen', 'New secret generated: ') : 'New secret generated: ') + secret + (window.t ? window.t('security.new_secret_alert', '\\n\\nIMPORTANT: Add this to your authenticator app now. You will need a code from this new secret to confirm the update!') : '\\n\\nIMPORTANT: Add this to your authenticator app now. You will need a code from this new secret to confirm the update!'));
                    }
                    async function updateAdminTotp(hasTotp) {
                        const current_password = document.getElementById('admin_totp_current_pass').value;
                        if (!current_password) return alert(window.t ? window.t('security.current_pass_required', 'Current password is required') : 'Current password is required');

                        let current_totp = null;
                        if (hasTotp) {
                            const currentTotpInput = document.getElementById('admin_totp_current_code');
                            current_totp = currentTotpInput ? currentTotpInput.value.trim() : null;
                            if (!current_totp) return alert(window.t ? window.t('security.code_required', 'Current 2FA code is required') : 'Current 2FA code is required');
                        }

                        const secret = document.getElementById('admin_totp_secret').value.trim();
                        if (!secret) return alert(window.t ? window.t('security.enter_secret_first', 'Enter or generate a secret first') : 'Enter or generate a secret first');
                        if (secret.length < 8) return alert(window.t ? window.t('security.secret_min_len', 'Secret must be at least 8 characters') : 'Secret must be at least 8 characters');
                        
                        const newTotpInput = document.getElementById('admin_totp_new_code');
                        const totp = newTotpInput ? newTotpInput.value.trim() : null;
                        if (!totp) return alert(window.t ? window.t('security.code_from_new', 'Enter 6-digit 2FA code from your NEW secret to verify') : 'Enter 6-digit 2FA code from your NEW secret to verify');

                        const data = await apiCall('/setup/admin/totp', 'POST', { current_password, secret, totp, current_totp });
                        if (data?.success) {
                            alert(window.t ? window.t('security.totp_verified', '2FA Secret updated and verified! Refreshing...') : '2FA Secret updated and verified! Refreshing...');
                            location.reload();
                        } else if (data?.error) {
                            alert('Error: ' + data.error);
                        }
                    }
                    async function disableAdminTotp() {
                        const current_password = document.getElementById('admin_totp_current_pass').value;
                        if (!current_password) return alert(window.t ? window.t('security.enter_pass_to_disable', 'Please enter your Current Password above first to disable 2FA') : 'Please enter your Current Password above first to disable 2FA');

                        const currentTotpInput = document.getElementById('admin_totp_current_code');
                        let current_totp = currentTotpInput ? currentTotpInput.value.trim() : null;
                        if (!current_totp) {
                            current_totp = prompt(window.t ? window.t('security.prompt_confirm_totp', 'Enter current 6-digit 2FA code to confirm disabling:') : 'Enter current 6-digit 2FA code to confirm disabling:');
                            if (!current_totp) return;
                        }

                        if (confirm(window.t ? window.t('security.confirm_disable_2fa', 'DANGER: This will disable 2FA for your admin account. Continue?') : 'DANGER: This will disable 2FA for your admin account. Continue?')) {
                            const data = await apiCall('/setup/admin/totp', 'POST', { current_password, secret: null, totp: current_totp, current_totp });
                            if (data?.success) {
                                alert(window.t ? window.t('security.totp_disabled', '2FA disabled!') : '2FA disabled!');
                                location.reload();
                            } else if (data?.error) {
                                alert('Error: ' + data.error);
                            }
                        }
                    }

                    // Offline Schedule (Zones Tab)
                    async function loadZones() {
                        const loading = document.getElementById('zones-loading');
                        const table = document.getElementById('zones-table');
                        const empty = document.getElementById('zones-empty');
                        const tbody = document.getElementById('zones-table-body');
                        loading.style.display = 'block';
                        table.style.display = 'none';
                        empty.style.display = 'none';

                        const data = await apiCall('/setup/zones/list', 'GET');
                        loading.style.display = 'none';
                        if (!data || data.length === 0) { empty.style.display = 'block'; return; }

                        let rows = '';
                        for (const z of data) {
                            const typeBadge = z.type === 'HOT_WATER' ? 'bg-info' : 'bg-secondary';
                            const noneText = window.t ? window.t('common.none', 'None') : 'None';
                            const vaCell = z.va_count > 0 ? z.va_count + ' VA' : '<span class="text-white-50" data-i18n="common.none">' + noneText + '</span>';
                            const ttCell = z.timetable_type || 'N/A';
                            const isVA = z.va_count > 0 && z.type !== 'HOT_WATER';

                            let offlineCell = '<span class="text-white-50 small">N/A</span>';
                            if (isVA) {
                                const chk = z.offline_schedule_enabled ? 'checked' : '';
                                const lblClass = z.offline_schedule_enabled ? 'text-success' : 'text-white-50';
                                const lblText = z.offline_schedule_enabled
                                    ? (window.t ? window.t('common.enabled', 'Enabled') : 'Enabled')
                                    : (window.t ? window.t('common.disabled', 'Disabled') : 'Disabled');
                                const i18nKey = z.offline_schedule_enabled ? 'common.enabled' : 'common.disabled';
                                offlineCell = '<div class="form-check form-switch d-inline-block">' +
                                    '<input class="form-check-input" type="checkbox" role="switch" id="ofsched_' + z.id + '" ' + chk +
                                    ' onchange="toggleOfflineSchedule(' + z.home_id + ',' + z.id + ',this.checked)">' +
                                    '<label class="form-check-label small ' + lblClass + '" for="ofsched_' + z.id + '" data-i18n="' + i18nKey + '">' + lblText + '</label>' +
                                    '</div>';
                            }

                            let syncCell = '';
                            if (z.offline_schedule_synced_at) {
                                syncCell = '<span class="small text-success">' + new Date(z.offline_schedule_synced_at).toLocaleString() + '</span>';
                            } else {
                                const neverText = window.t ? window.t('common.never', 'Never') : 'Never';
                                syncCell = '<span class="small text-white-50" data-i18n="common.never">' + neverText + '</span>';
                            }

                            let actionCell = '';
                            if (isVA) {
                                const syncNowText = window.t ? window.t('zones.sync_now', '&#x21bb; Sync Now') : '&#x21bb; Sync Now';
                                actionCell = '<button class="btn btn-sm btn-outline-primary" id="sync-btn-' + z.id + '" ' +
                                    'onclick="syncOfflineSchedule(' + z.home_id + ',' + z.id + ')" data-i18n="zones.sync_now">' + syncNowText + '</button>';
                            }

                            rows += '<tr>' +
                                '<td><strong>' + z.name + '</strong> <span class="text-white-50 small">(ID: ' + z.id + ')</span></td>' +
                                '<td><span class="badge ' + typeBadge + '">' + z.type + '</span></td>' +
                                '<td>' + vaCell + '</td>' +
                                '<td><span class="badge bg-dark border border-secondary">' + ttCell + '</span></td>' +
                                '<td>' + offlineCell + '</td>' +
                                '<td>' + syncCell + '</td>' +
                                '<td>' + actionCell + '</td>' +
                                '</tr>';
                        }
                        tbody.innerHTML = rows;
                        if (window.applyTranslations) window.applyTranslations(tbody);
                        table.style.display = 'table';
                    }

                    async function toggleOfflineSchedule(homeId, zoneId, enabled) {
                        const label = document.querySelector('label[for="ofsched_' + zoneId + '"]');
                        const checkbox = document.getElementById('ofsched_' + zoneId);
                        label.textContent = window.t ? window.t('zones.pushing', 'Pushing...') : 'Pushing...';
                        label.className = 'form-check-label small text-warning';

                        const result = await apiCall('/setup/zones/' + zoneId + '/offline-schedule', 'POST', { homeId: homeId, enabled: enabled });
                        if (result && result.success) {
                            const lbl = enabled ? (window.t ? window.t('common.enabled', 'Enabled') : 'Enabled') : (window.t ? window.t('common.disabled', 'Disabled') : 'Disabled');
                            label.textContent = lbl;
                            label.setAttribute('data-i18n', enabled ? 'common.enabled' : 'common.disabled');
                            label.className = 'form-check-label small ' + (enabled ? 'text-success' : 'text-white-50');
                        } else {
                            checkbox.checked = !enabled;
                            const lbl = !enabled ? (window.t ? window.t('common.enabled', 'Enabled') : 'Enabled') : (window.t ? window.t('common.disabled', 'Disabled') : 'Disabled');
                            label.textContent = lbl;
                            label.setAttribute('data-i18n', !enabled ? 'common.enabled' : 'common.disabled');
                            label.className = 'form-check-label small ' + (!enabled ? 'text-success' : 'text-white-50');
                        }
                    }

                    async function syncOfflineSchedule(homeId, zoneId) {
                        const btn = document.getElementById('sync-btn-' + zoneId);
                        const origHtml = btn.innerHTML;
                        btn.disabled = true;
                        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> ' + (window.t ? window.t('zones.syncing', 'Syncing...') : 'Syncing...');

                        const result = await apiCall('/setup/zones/' + zoneId + '/offline-schedule/sync', 'POST', { homeId: homeId });
                        btn.disabled = false;
                        if (result && result.success) {
                            btn.innerHTML = window.t ? window.t('zones.synced', '&#x2713; Synced!') : '&#x2713; Synced!';
                            btn.className = 'btn btn-sm btn-outline-success';
                            setTimeout(function() { btn.innerHTML = origHtml; btn.className = 'btn btn-sm btn-outline-primary'; loadZones(); }, 2000);
                        } else {
                            btn.innerHTML = origHtml;
                        }
                    }

                    // Auto-load zones when tab is shown
                    document.getElementById('tab-zones').addEventListener('click', loadZones);
                    document.getElementById('tab-tuning').addEventListener('click', loadTuning);

                    // Actuator Limits Tab
                    async function loadTuning() {
                        const deviceLoading = document.getElementById('tuning-devices-loading');
                        const deviceContainer = document.getElementById('tuning-devices-container');
                        const deviceTbody = document.getElementById('tuning-devices-tbody');

                        deviceLoading.style.display = 'block';
                        deviceContainer.style.display = 'none';

                        const data = await apiCall('/setup/tuning/list', 'GET');
                        deviceLoading.style.display = 'none';

                        if (!data) return;

                        // Populate Devices
                        let deviceRows = '';
                        if (data.devices && data.devices.length > 0) {
                            data.devices.forEach(d => {
                                const lowVal = d.field_0273 !== null ? d.field_0273 : '';
                                const highVal = d.field_027c !== null ? d.field_027c : '';
                                const calVal = d.field_0280 !== null ? d.field_0280 : '';
                                const activeBadge = d.field_028c 
                                    ? '<span class="badge bg-success" data-i18n="common.active">' + (window.t ? window.t('common.active', 'Active') : 'Active') + '</span>' 
                                    : '<span class="badge bg-secondary" data-i18n="common.inactive">' + (window.t ? window.t('common.inactive', 'Inactive') : 'Inactive') + '</span>';
                                const saveText = window.t ? window.t('common.save', 'Save') : 'Save';

                                deviceRows += '<tr>' +
                                    '<td><strong>' + d.serial_no + '</strong></td>' +
                                    '<td>' + (d.home_name || '-') + '</td>' +
                                    '<td><input type="number" class="form-control form-control-sm bg-dark text-white border-secondary" id="low_' + d.serial_no + '" value="' + lowVal + '" placeholder="steps"></td>' +
                                    '<td><input type="number" class="form-control form-control-sm bg-dark text-white border-secondary" id="high_' + d.serial_no + '" value="' + highVal + '" placeholder="steps"></td>' +
                                    '<td><input type="number" class="form-control form-control-sm bg-dark text-white border-secondary" id="cal_' + d.serial_no + '" value="' + calVal + '" placeholder="const"></td>' +
                                    '<td><code>Pos: ' + (d.field_0265 !== null ? d.field_0265 : '-') + ' | Pos2: ' + (d.field_0266 !== null ? d.field_0266 : '-') + '</code><br/>' + activeBadge + '</td>' +
                                    '<td>' +
                                        '<div class="small text-white-50" style="font-size: 0.8rem; line-height: 1.2;">' +
                                            '<div><strong>State:</strong> <span class="text-info">' + (d.field_016a || 'UNKNOWN') + '</span></div>' +
                                            '<div><strong>Seat/Ref:</strong> ' + (d.field_01b6 !== null ? d.field_01b6 : '-') + ' / ' + (d.field_01b5 !== null ? d.field_01b5 : '-') + '</div>' +
                                            '<div><strong>Mode/Flags:</strong> ' + (d.field_01fa !== null ? d.field_01fa : '-') + ' / ' + (d.field_01fb !== null ? d.field_01fb : '-') + '</div>' +
                                            '<div>' + (d.field_0283 !== null && d.field_0283 !== 32767 
                                                ? ('<span class="' + ( (d.field_0283 < -100 || d.field_0283 > 100) ? 'text-danger fw-bold' : (Math.abs(d.field_0283) > 10 ? 'text-warning' : 'text-success') ) + '">' +
                                                   'Dev: ' + (d.field_0283 > 0 ? '+' : '') + d.field_0283 + '</span>' + 
                                                   ((d.field_0283 < -100 || d.field_0283 > 100) ? ' <span class="badge bg-danger">Stuck</span>' : ''))
                                                : '<span class="text-muted">Dev: N/A</span>'
                                            ) + '</div>' +
                                        '</div>' +
                                    '</td>' +
                                    '<td><button class="btn btn-sm btn-primary" onclick="saveActuatorLimits(\\\'' + d.serial_no + '\\\')" data-i18n="common.save">' + saveText + '</button></td>' +
                                 '</tr>';
                            });
                            deviceTbody.innerHTML = deviceRows;
                            if (window.applyTranslations) window.applyTranslations(deviceTbody);
                            deviceContainer.style.display = 'block';
                        } else {
                            const emptyMsg = window.t ? window.t('tuning.empty', 'No Valve Actuators found') : 'No Valve Actuators found';
                            deviceTbody.innerHTML = '<tr><td colspan="7" class="text-center text-white-50" data-i18n="tuning.empty">' + emptyMsg + '</td></tr>';
                            deviceContainer.style.display = 'block';
                        }
                    }

                    async function saveActuatorLimits(serial) {
                        const lowSteps = document.getElementById('low_' + serial).value;
                        const highSteps = document.getElementById('high_' + serial).value;
                        const driveConstant = document.getElementById('cal_' + serial).value;

                        const body = {
                            lowSteps: lowSteps !== '' ? parseInt(lowSteps) : null,
                            highSteps: highSteps !== '' ? parseInt(highSteps) : null,
                            driveConstant: driveConstant !== '' ? parseInt(driveConstant) : null
                        };

                        const result = await apiCall('/setup/devices/' + serial + '/actuator-limits', 'POST', body);
                        if (result && result.success) {
                            alert((window.t ? window.t('tuning.success', 'Actuator limits successfully pushed and saved!') : 'Actuator limits successfully pushed and saved!') + ' (MID: ' + result.mid + ')');
                            loadTuning();
                        } else {
                            alert(window.t ? window.t('tuning.failed', 'Failed to save actuator limits') : 'Failed to save actuator limits');
                        }
                    }

                    // Decoder
                    async function refreshCache() {
                        const select = document.getElementById('decoder_cache_select');
                        const data = await apiCall('/setup/cache', 'GET');
                        if (!data) return;

                        select.innerHTML = '<option value="">-- Select a cached message --</option>';
                        for (const [deviceId, paths] of Object.entries(data)) {
                            const optGroup = document.createElement('optgroup');
                            optGroup.label = 'Device: ' + deviceId;
                            for (const [pathKey, sources] of Object.entries(paths)) {
                                for (const [source, entry] of Object.entries(sources)) {
                                    if (entry && entry.hex) {
                                        const label = source.toUpperCase();
                                        const opt = document.createElement('option');
                                        // Store both response hex and request hex as JSON
                                        opt.value = JSON.stringify({ hex: entry.hex, requestHex: entry.request?.hex || null });
                                        opt.textContent = pathKey + ' [' + label + ']' + (entry.timestamp ? ' ' + entry.timestamp.substring(11,19) : '');
                                        optGroup.appendChild(opt);
                                    }
                                }
                            }
                            select.appendChild(optGroup);
                        }
                    }

                    document.getElementById('decoder_cache_select').addEventListener('change', (e) => {
                        if (e.target.value) {
                            try {
                                const parsed = JSON.parse(e.target.value);
                                document.getElementById('decoder_hex').value = parsed.hex;
                                decodeHex();
                                // If there's a paired request, decode that too
                                if (parsed.requestHex) {
                                    setTimeout(() => {
                                        const reqTextarea = document.getElementById('decoder_request_hex');
                                        if (reqTextarea) reqTextarea.value = parsed.requestHex;
                                    }, 100);
                                }
                            } catch (ex) {
                                // Fallback: treat as raw hex
                                document.getElementById('decoder_hex').value = e.target.value;
                                decodeHex();
                            }
                        }
                    });

                    // Auto-refresh cache when tab is clicked
                    document.getElementById('tab-decoder').addEventListener('click', refreshCache);
                    
                    // Also load the cache on initial page load so it's ready
                    document.addEventListener('DOMContentLoaded', refreshCache);

                    async function decodeHex() {
                        const hex = document.getElementById('decoder_hex').value.trim();
                        if (!hex) return;
                        
                        const jsonPre = document.getElementById('decoder_json');
                        const resultsDiv = document.getElementById('decoder_results');
                        resultsDiv.style.display = 'none';

                        const data = await apiCall('/setup/decode', 'POST', { hex });
                        if (!data) return;

                        resultsDiv.style.display = 'block';
                        jsonPre.textContent = JSON.stringify(data, null, 2);

                        // Bridge
                        const bridgeCard = document.getElementById('bridge_card');
                        if (data.bridge) {
                            bridgeCard.style.display = 'block';
                            const devInfo = data.bridge.device 
                                ? '<b class="text-success">' + data.bridge.device.serialNo + ' (' + data.bridge.device.type + ')</b>'
                                : '<b class="text-warning">Unknown (Not in local DB)</b>';
                                
                            document.getElementById('bridge_info').innerHTML = 
                                '<div class="btn-group w-100 mb-2">' +
                                    '<span class="btn btn-sm btn-outline-info disabled opacity-100">Dir: ' + data.bridge.direction + '</span>' +
                                    '<span class="btn btn-sm btn-outline-info disabled opacity-100">Port: ' + data.bridge.udpPort + '</span>' +
                                '</div>' +
                                '<div class="p-2 bg-black rounded border border-secondary mb-2">' +
                                    '<div class="small text-white-50">IPv6:</div>' +
                                    '<code class="text-info">' + data.bridge.ipv6 + '</code>' +
                                '</div>' +
                                '<div class="p-2 bg-black rounded border border-secondary">' +
                                    '<div class="small text-white-50">Assigned Device:</div>' +
                                    devInfo +
                                '</div>' +
                                '<div class="mt-2 text-white-50 font-monospace" style="font-size: 0.7rem;">' +
                                    'FieldA: ' + data.bridge.fields.fieldA + ' | FieldB: ' + data.bridge.fields.fieldB + ' | FieldC: ' + data.bridge.fields.fieldC +
                                '</div>';
                        } else {
                            bridgeCard.style.display = 'none';
                        }

                        // CoAP
                        const coapCard = document.getElementById('coap_card');
                        if (data.coap) {
                            coapCard.style.display = 'block';
                            let optionsHtml = '';
                            data.coap.options.forEach(o => {
                                optionsHtml += '<div class="text-white-50 border-bottom border-secondary py-1">' +
                                    o.name + ': <code class="text-white">' + o.value + '</code>' +
                                '</div>';
                            });

                            document.getElementById('coap_info').innerHTML = 
                                '<div class="btn-group w-100 mb-2">' +
                                    '<span class="btn btn-sm btn-outline-primary disabled opacity-100">' + data.coap.method + '</span>' +
                                    '<span class="btn btn-sm btn-outline-primary disabled opacity-100">MID: ' + data.coap.mid + '</span>' +
                                    '<span class="btn btn-sm btn-outline-primary disabled opacity-100">Token: ' + data.coap.token + '</span>' +
                                '</div>' +
                                '<div class="p-2 bg-black rounded border border-secondary mb-2">' +
                                    '<div class="small text-white-50">URI-Path:</div>' +
                                    '<code>/' + data.coap.path + '</code>' +
                                '</div>' +
                                '<div class="p-2 bg-black rounded border border-secondary">' +
                                    '<div class="small text-white-50">Options Breakdown:</div>' +
                                    '<div class="small" style="max-height: 80px; overflow-y: auto;">' +
                                        optionsHtml +
                                    '</div>' +
                                '</div>';
                        } else {
                            coapCard.style.display = 'none';
                        }

                        // TLV
                        const tlvCard = document.getElementById('tlv_card');
                        const tlvBody = document.getElementById('tlv_table_body');
                        if (data.tlv && data.tlv.items.length > 0) {
                            tlvCard.style.display = 'block';
                            let rows = '';
                            data.tlv.items.forEach(item => {
                                rows += '<tr>' +
                                    '<td><code>' + item.fid + '</code></td>' +
                                    '<td><span class="text-info">' + item.name + '</span></td>' +
                                    '<td><b class="text-white">' + item.value + '</b></td>' +
                                    '<td class="text-white-50">' + (item.unit || '<i class="opacity-25">-</i>') + '</td>' +
                                    '<td><code>' + item.raw + '</code></td>' +
                                '</tr>';
                            });
                            tlvBody.innerHTML = rows;
                        } else {
                            tlvCard.style.display = 'none';
                        }
                    }

                    // Seeding
                    async function startSeeding() {
                        const data = await apiCall('/setup/seed/start');
                        if(data?.user_code) {
                            document.getElementById('seedStatus').innerHTML = 'Please visit <a href="' + data.verification_uri + '" target="_blank">' + data.verification_uri + '</a> and enter code: <b>' + data.user_code + '</b>';
                            pollSeed();
                        }
                    }
                    async function pollSeed() {
                        const res = await fetch('/setup/seed/check');
                        const data = await res.json();
                        if(data.status === 'pending') setTimeout(pollSeed, 5000);
                        else if(data.status === 'success') location.reload();
                    }

                    // --- Settings Tab Functions ---
                    async function loadSettings() {
                        const data = await apiCall('/setup/settings', 'GET');
                        if (!data) return;
                        document.getElementById('settings_log_level').value = data.log_level || 'debug';
                        document.getElementById('settings_jwt_secret').value = data.jwt_secret || '';
                        document.getElementById('settings_carto_api_key').value = data.carto_api_key || '';
                        document.getElementById('settings_cleanup_device_measurements_days').value = data.cleanup_device_measurements_days || 30;
                        document.getElementById('settings_cleanup_zone_measurements_days').value = data.cleanup_zone_measurements_days || 390;
                        document.getElementById('settings_cleanup_circuit_measurements_days').value = data.cleanup_circuit_measurements_days || 390;
                        document.getElementById('settings_cleanup_home_weather_days').value = data.cleanup_home_weather_days || 390;
                        document.getElementById('settings_swagger_enabled').checked = !!data.swagger_enabled;
                        document.getElementById('settings_ota_auto_update').checked = data.ota_auto_update !== false;
                    }

                    async function saveServerSettings() {
                        const logLevel = document.getElementById('settings_log_level').value;
                        const jwtInput = document.getElementById('settings_jwt_secret');
                        const jwtSecret = jwtInput.readOnly ? null : jwtInput.value;
                        const cartoApiKey = document.getElementById('settings_carto_api_key').value;
                        const deviceDays = parseInt(document.getElementById('settings_cleanup_device_measurements_days').value, 10);
                        const zoneDays = parseInt(document.getElementById('settings_cleanup_zone_measurements_days').value, 10);
                        const circuitDays = parseInt(document.getElementById('settings_cleanup_circuit_measurements_days').value, 10);
                        const weatherDays = parseInt(document.getElementById('settings_cleanup_home_weather_days').value, 10);
                        const swaggerEnabled = document.getElementById('settings_swagger_enabled').checked;

                        if (isNaN(deviceDays) || deviceDays < 1) {
                            alert(window.t ? window.t('settings.retention_device_error', 'Device measurements retention must be at least 1 day.') : 'Device measurements retention must be at least 1 day.');
                            return;
                        }
                        if (isNaN(zoneDays) || zoneDays < 1) {
                            alert(window.t ? window.t('settings.retention_zone_error', 'Zone measurements retention must be at least 1 day.') : 'Zone measurements retention must be at least 1 day.');
                            return;
                        }
                        if (isNaN(circuitDays) || circuitDays < 1) {
                            alert(window.t ? window.t('settings.retention_circuit_error', 'Circuit measurements retention must be at least 1 day.') : 'Circuit measurements retention must be at least 1 day.');
                            return;
                        }
                        if (isNaN(weatherDays) || weatherDays < 1) {
                            alert(window.t ? window.t('settings.retention_weather_error', 'Home weather retention must be at least 1 day.') : 'Home weather retention must be at least 1 day.');
                            return;
                        }

                        const body = {
                            log_level: logLevel,
                            carto_api_key: cartoApiKey,
                            cleanup_device_measurements_days: deviceDays,
                            cleanup_zone_measurements_days: zoneDays,
                            cleanup_circuit_measurements_days: circuitDays,
                            cleanup_home_weather_days: weatherDays,
                            swagger_enabled: swaggerEnabled,
                            ota_auto_update: document.getElementById('settings_ota_auto_update').checked
                        };
                        if (jwtSecret !== null && jwtSecret.length > 0) {
                            if (!confirm(window.t ? window.t('settings.confirm_jwt', 'WARNING: Changing the JWT secret will invalidate ALL existing sessions (app logins, setup portal cookies). Continue?') : 'WARNING: Changing the JWT secret will invalidate ALL existing sessions (app logins, setup portal cookies). Continue?')) return;
                            body.jwt_secret = jwtSecret;
                        }

                        const data = await apiCall('/setup/settings', 'POST', body);
                        if (data && data.success) {
                            alert(window.t ? window.t('settings.settings_saved', 'Settings saved! Configuration updated successfully.') : 'Settings saved! Configuration updated successfully.');
                            jwtInput.readOnly = true;
                            if (body.jwt_secret) {
                                alert(window.t ? window.t('settings.jwt_updated', 'JWT Secret updated. You may need to re-login.') : 'JWT Secret updated. You may need to re-login.');
                                location.reload();
                            }
                        }
                    }

                    async function triggerOtaSync() {
                        const btn = document.getElementById('ota_sync_btn');
                        const status = document.getElementById('ota_sync_status');
                        btn.disabled = true;
                        status.innerHTML = '<span class="text-warning">Syncing...</span>';
                        try {
                            const data = await apiCall('/setup/ota/sync', 'POST');
                            if (data && data.success) {
                                const m = data.manifest || {};
                                status.innerHTML = '<span class="text-success">✓ Sync complete — web v' + (m.webVersionName || '?') + ' (code ' + (m.webVersionCode || '?') + ')</span>';
                            } else {
                                status.innerHTML = '<span class="text-danger">Sync returned unexpected response</span>';
                            }
                        } catch (err) {
                            status.innerHTML = '<span class="text-danger">Sync failed: ' + (err.message || err) + '</span>';
                        } finally {
                            btn.disabled = false;
                        }
                    }

                    function toggleJwtVisibility() {
                        const input = document.getElementById('settings_jwt_secret');
                        input.type = input.type === 'password' ? 'text' : 'password';
                    }

                    function toggleCartoKeyVisibility() {
                        const input = document.getElementById('settings_carto_api_key');
                        input.type = input.type === 'password' ? 'text' : 'password';
                    }

                    function generateJwtSecret() {
                        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
                        let secret = '';
                        for (let i = 0; i < 48; i++) secret += chars.charAt(Math.floor(Math.random() * chars.length));
                        const input = document.getElementById('settings_jwt_secret');
                        input.value = secret;
                        input.readOnly = false;
                        input.type = 'text';
                    }

                    async function restartServer() {
                        if (!confirm(window.t ? window.t('settings.confirm_restart', 'Are you sure you want to restart the server? All WebSocket connections will be dropped.') : 'Are you sure you want to restart the server? All WebSocket connections will be dropped.')) return;
                        const btn = document.getElementById('restart_btn');
                        const status = document.getElementById('restart_status');
                        btn.disabled = true;
                        status.innerHTML = '<span class="text-warning">' + (window.t ? window.t('settings.restart_sent', 'Sending restart command...') : 'Sending restart command...') + '</span>';

                        try {
                            await fetch('/setup/server/restart', { method: 'POST' }).catch(() => {});
                        } catch (e) { /* Expected - server is shutting down */ }

                        const countPrefix = window.t ? window.t('settings.restarting_countdown', 'Server is restarting... Auto-refreshing in ') : 'Server is restarting... Auto-refreshing in ';
                        status.innerHTML = '<span class="text-info">' + countPrefix + '8 seconds.</span>';
                        let countdown = 8;
                        const interval = setInterval(() => {
                            countdown--;
                            status.innerHTML = '<span class="text-info">' + countPrefix + countdown + 's</span>';
                            if (countdown <= 0) {
                                clearInterval(interval);
                                location.reload();
                            }
                        }, 1000);
                    }

                    // --- MQTT Functions ---
                    async function loadMqttSettings() {
                        const data = await apiCall('/setup/mqtt', 'GET');
                        if (!data) return;
                        document.getElementById('mqtt_host').value = data.host || '';
                        document.getElementById('mqtt_port').value = data.port || 1883;
                        document.getElementById('mqtt_user').value = data.user || '';
                        document.getElementById('mqtt_password').value = data.password || '';
                        document.getElementById('mqtt_ha_discovery').checked = !!data.ha_discovery;
                        document.getElementById('mqtt_ha_path').value = data.ha_path || 'homeassistant';
                    }

                    async function saveMqttSettings() {
                        const body = {
                            host: document.getElementById('mqtt_host').value,
                            port: parseInt(document.getElementById('mqtt_port').value) || 1883,
                            user: document.getElementById('mqtt_user').value,
                            password: document.getElementById('mqtt_password').value,
                            ha_discovery: document.getElementById('mqtt_ha_discovery').checked,
                            ha_path: document.getElementById('mqtt_ha_path').value || 'homeassistant'
                        };
                        const data = await apiCall('/setup/mqtt', 'POST', body);
                        if (data && data.success) {
                            const status = document.getElementById('mqtt_status');
                            status.innerHTML = '<span class="text-success">' + (window.t ? window.t('settings.mqtt_saved', 'MQTT settings saved!') : 'MQTT settings saved!') + '</span>';
                            setTimeout(() => { status.innerHTML = ''; }, 3000);
                        }
                    }

                    async function testMqttConnection() {
                        const btn = document.getElementById('mqtt_test_btn');
                        const status = document.getElementById('mqtt_status');
                        btn.disabled = true;
                        btn.textContent = window.t ? window.t('settings.testing', 'Testing...') : 'Testing...';
                        status.innerHTML = '';

                        const body = {
                            host: document.getElementById('mqtt_host').value,
                            port: parseInt(document.getElementById('mqtt_port').value) || 1883,
                            user: document.getElementById('mqtt_user').value,
                            password: document.getElementById('mqtt_password').value
                        };

                        const data = await apiCall('/setup/mqtt/test', 'POST', body);
                        btn.disabled = false;
                        btn.textContent = window.t ? window.t('settings.btn_test_conn', 'Test Connection') : 'Test Connection';
                        if (data && data.success) {
                            status.innerHTML = '<span class="text-success">' + (window.t ? window.t('settings.mqtt_success', '✓ Connected successfully!') : '✓ Connected successfully!') + '</span>';
                        } else {
                            status.innerHTML = '<span class="text-danger">' + (window.t ? window.t('settings.mqtt_failed', '✗ Connection failed: ') : '✗ Connection failed: ') + (data?.error || 'Unknown error') + '</span>';
                        }
                    }

                    // --- State Snapshot Functions ---
                    let snapPollInterval = null;

                    async function loadSnapshotData() {
                        await Promise.all([loadSnapshotProgress(), loadSnapshotHistory()]);
                    }

                    async function loadSnapshotProgress() {
                        const homeId = document.getElementById('snap_home').value;
                        try {
                            const res = await fetch('/setup/homes/' + homeId + '/snapshot/progress');
                            const data = await res.json();

                            const bar = document.getElementById('snap_progress_bar');
                            const text = document.getElementById('snap_progress_text');
                            const table = document.getElementById('snap_progress_table');
                            const tbody = document.getElementById('snap_progress_tbody');
                            const startBtn = document.getElementById('snap_start_btn');
                            const stopBtn = document.getElementById('snap_stop_btn');
                            const statusBadge = document.getElementById('snap_status');

                            if (!data || data.status === 'none') {
                                bar.style.width = '0%';
                                text.textContent = window.t ? window.t('snapshot.no_capture', 'No capture active. Start one or enable proxy mode.') : 'No capture active. Start one or enable proxy mode.';
                                table.style.display = 'none';
                                startBtn.disabled = false;
                                stopBtn.disabled = true;
                                statusBadge.className = 'badge bg-secondary align-self-center ms-2';
                                statusBadge.textContent = window.t ? window.t('snapshot.status_not_started', 'Not Started') : 'Not Started';
                                if (snapPollInterval) { clearInterval(snapPollInterval); snapPollInterval = null; }
                                return;
                            }

                            const pct = data.total > 0 ? Math.round(data.captured / data.total * 100) : 0;
                            bar.style.width = pct + '%';
                            text.textContent = data.captured + '/' + data.total + ' messages captured (' + pct + '%) — Required: ' + data.requiredCaptured + '/' + data.requiredTotal;
                            table.style.display = '';

                            const isCapturing = data.status === 'capturing';
                            startBtn.disabled = isCapturing;
                            stopBtn.disabled = !isCapturing;
                            statusBadge.className = 'badge align-self-center ms-2 ' +
                                (isCapturing ? 'bg-info' : data.status === 'complete' ? 'bg-success' : 'bg-warning');
                            statusBadge.textContent = isCapturing 
                                ? (window.t ? window.t('snapshot.status_capturing', 'Capturing...') : 'Capturing...') 
                                : data.status === 'complete' 
                                    ? (window.t ? window.t('snapshot.status_complete', 'Complete') : 'Complete') 
                                    : (window.t ? window.t('snapshot.status_incomplete', 'Incomplete') : 'Incomplete');

                            tbody.innerHTML = (data.items || []).map(item => {
                                let icon = item.captured ? '✅' : (item.optional ? '⚪' : '❌');
                                let rowClass = item.captured ? '' : (item.optional ? 'opacity-50' : 'text-danger');
                                return '<tr class="' + rowClass + '">' +
                                    '<td>' + item.entity + ' <code class="small">' + item.entityId + '</code></td>' +
                                    '<td><span class="badge bg-secondary">' + item.type + '</span></td>' +
                                    '<td class="font-monospace small">' + item.path + '</td>' +
                                    '<td>' + icon + '</td>' +
                                    '<td class="small">' + (item.captured_at ? new Date(item.captured_at).toLocaleTimeString() : '-') + '</td>' +
                                '</tr>';
                            }).join('');
                            if (window.applyTranslations) window.applyTranslations(tbody);

                            // Auto-poll while capturing
                            if (isCapturing && !snapPollInterval) {
                                snapPollInterval = setInterval(loadSnapshotProgress, 5000);
                            } else if (!isCapturing && snapPollInterval) {
                                clearInterval(snapPollInterval);
                                snapPollInterval = null;
                            }
                        } catch (e) {
                            console.error('Snapshot progress error:', e);
                        }
                    }

                    async function loadSnapshotHistory() {
                        const homeId = document.getElementById('snap_home').value;
                        try {
                            const res = await fetch('/setup/homes/' + homeId + '/snapshot/list');
                            const data = await res.json();
                            document.getElementById('snap_history_loading').style.display = 'none';
                            const table = document.getElementById('snap_history_table');
                            const tbody = document.getElementById('snap_history_tbody');
                            table.style.display = '';
                            tbody.innerHTML = (data || []).map(s => '<tr>' +
                                '<td>' + s.id + '</td>' +
                                '<td class="small">' + new Date(s.created_at).toLocaleString() + '</td>' +
                                '<td><span class="badge ' + (s.status === 'complete' ? 'bg-success' : s.status === 'capturing' ? 'bg-info' : 'bg-warning') + '">' + s.status + '</span></td>' +
                                '<td class="small">' + (s.json_size ? Math.round(s.json_size / 1024) + ' KB' : '-') + '</td>' +
                                '<td>' +
                                    '<button class="btn btn-outline-success btn-sm py-0 px-2" onclick="restoreSnapshot(' + homeId + ', ' + s.id + ')" title="Restore">⟲</button> ' +
                                    '<a href="/setup/homes/' + homeId + '/snapshot/' + s.id + '/export" class="btn btn-outline-info btn-sm py-0 px-2" title="Export">↓</a> ' +
                                    '<button class="btn btn-outline-danger btn-sm py-0 px-2" onclick="deleteSnapshot(' + homeId + ', ' + s.id + ')" title="Delete">✕</button>' +
                                '</td>' +
                            '</tr>').join('');
                            if (window.applyTranslations) window.applyTranslations(tbody);
                        } catch (e) { console.error('Snapshot history error:', e); }
                    }

                    async function startSnapshotCapture() {
                        const homeId = document.getElementById('snap_home').value;
                        await apiCall('/setup/homes/' + homeId + '/snapshot/start');
                        loadSnapshotData();
                    }

                    async function stopSnapshotCapture() {
                        const homeId = document.getElementById('snap_home').value;
                        await apiCall('/setup/homes/' + homeId + '/snapshot/stop');
                        if (snapPollInterval) { clearInterval(snapPollInterval); snapPollInterval = null; }
                        loadSnapshotData();
                    }

                    async function restoreSnapshot(homeId, snapshotId) {
                        if (!confirm(window.t ? window.t('snapshot.confirm_restore', 'Restore this snapshot? This will overwrite current TaNoClo configuration with the original Tado state. Commands will be queued with 2s delays.') : 'Restore this snapshot? This will overwrite current TaNoClo configuration with the original Tado state. Commands will be queued with 2s delays.')) return;
                        const result = await apiCall('/setup/homes/' + homeId + '/snapshot/' + snapshotId + '/restore');
                        if (result) alert((window.t ? window.t('snapshot.restore_complete', 'Restore complete: ') : 'Restore complete: ') + result.restored + ' commands sent.');
                    }

                    async function deleteSnapshot(homeId, snapshotId) {
                        if (!confirm(window.t ? window.t('snapshot.confirm_delete', 'Delete this snapshot permanently?') : 'Delete this snapshot permanently?')) return;
                        await apiCall('/setup/homes/' + homeId + '/snapshot/' + snapshotId, 'DELETE');
                        loadSnapshotData();
                    }

                    async function importSnapshot() {
                        const homeId = document.getElementById('snap_home').value;
                        const fileInput = document.getElementById('snap_import_file');
                        if (!fileInput.files[0]) return alert(window.t ? window.t('snapshot.select_file', 'Select a file first') : 'Select a file first');
                        const text = await fileInput.files[0].text();
                        try { JSON.parse(text); } catch(e) { return alert(window.t ? window.t('snapshot.invalid_json', 'Invalid JSON file') : 'Invalid JSON file'); }
                        await apiCall('/setup/homes/' + homeId + '/snapshot/import', 'POST', { snapshot_json: text });
                        loadSnapshotData();
                    }

                    // --- Emulated Devices & ESP32 Nodes Functions ---
                    async function loadEmulatedData() {
                        try {
                            const [nodesRes, devsRes] = await Promise.all([
                                fetch('/setup/emulated/nodes').then(r => r.json()),
                                fetch('/setup/emulated/devices').then(r => r.json())
                            ]);

                            // 1. Render ESP32 Nodes
                            const nodesTbody = document.getElementById('emul_nodes_tbody');
                            const nodeSelect = document.getElementById('emul_dev_node');
                            const nodes = nodesRes.nodes || [];
                            
                            if (nodes.length === 0) {
                                const noNodesText = window.t ? window.t('emulated.no_nodes', 'No ESP32 hardware nodes registered. Add one above.') : 'No ESP32 hardware nodes registered. Add one above.';
                                const noNodesAvail = window.t ? window.t('emulated.no_nodes_avail', 'No nodes available') : 'No nodes available';
                                nodesTbody.innerHTML = '<tr><td colspan="8" class="text-white-50 text-center py-2" data-i18n="emulated.no_nodes">' + noNodesText + '</td></tr>';
                                nodeSelect.innerHTML = '<option value="" data-i18n="emulated.no_nodes_avail">' + noNodesAvail + '</option>';
                            } else {
                                const clearNvramText = window.t ? window.t('emulated.btn_clear_nvram', 'Clear NVRAM') : 'Clear NVRAM';
                                const rebootText = window.t ? window.t('emulated.btn_reboot', 'Reboot') : 'Reboot';
                                nodesTbody.innerHTML = nodes.map(n => {
                                    const keyDisplay = n.api_key 
                                        ? '<span class="font-monospace small text-white-50" title="' + n.api_key + '">••••••••</span> ' +
                                          '<button class="btn btn-sm btn-link p-0 text-info" data-key="' + n.api_key + '" onclick="copyNodeApiKey(this)" title="Copy Key"><i class="bi bi-clipboard"></i></button> ' +
                                          '<button class="btn btn-sm btn-link p-0 text-warning ms-1" data-id="' + n.id + '" data-key="' + n.api_key + '" onclick="editNodeApiKey(this.dataset.id, this.dataset.key)" title="Edit Key"><i class="bi bi-pencil"></i></button>'
                                        : '<span class="text-white-50 small">None</span> <button class="btn btn-sm btn-link p-0 text-success ms-1" data-id="' + n.id + '" data-key="" onclick="editNodeApiKey(this.dataset.id, this.dataset.key)" title="Set Key"><i class="bi bi-plus-circle"></i></button>';

                                    return '<tr>' +
                                        '<td>' + n.id + '</td>' +
                                        '<td><strong class="text-white">' + n.name + '</strong></td>' +
                                        '<td><code>' + n.ip_address + '</code></td>' +
                                        '<td>' + n.api_port + '</td>' +
                                        '<td>' + keyDisplay + '</td>' +
                                        '<td><span class="badge ' + (n.status === 'ONLINE' ? 'bg-success' : (n.status === 'OFFLINE' ? 'bg-danger' : (n.status === 'UNAUTHORIZED' ? 'bg-danger text-white' : 'bg-warning text-dark'))) + '">' + n.status + '</span></td>' +
                                        '<td class="small text-white-50">' + (n.last_seen ? new Date(n.last_seen).toLocaleTimeString() : '-') + '</td>' +
                                        '<td class="table-actions-cell">' +
                                            '<div class="d-inline-flex align-items-center gap-1 justify-content-end">' +
                                                '<button class="btn-action-warning" data-node-id="' + n.id + '" onclick="clearEsp32Nvs(this.dataset.nodeId)" title="Clear all emulated devices from ESP32 NVRAM"><i class="bi bi-eraser-fill"></i> <span data-i18n="emulated.btn_clear_nvram">' + clearNvramText + '</span></button>' +
                                                '<button class="btn-action-telemetry" id="reboot_btn_' + n.id + '" data-node-id="' + n.id + '" onclick="rebootEsp32Node(this.dataset.nodeId)" title="Reboot ESP32 hardware"><i class="bi bi-arrow-clockwise"></i> <span data-i18n="emulated.btn_reboot">' + rebootText + '</span></button>' +
                                                '<button class="btn-action-danger" data-node-id="' + n.id + '" onclick="deleteEsp32Node(this.dataset.nodeId)" title="Delete node from database"><i class="bi bi-trash"></i></button>' +
                                            '</div>' +
                                        '</td>' +
                                    '</tr>';
                                }).join('');

                                const selNodeText = window.t ? window.t('emulated.select_node', 'Select Node...') : 'Select Node...';
                                nodeSelect.innerHTML = '<option value="" data-i18n="emulated.select_node">' + selNodeText + '</option>' +
                                    nodes.map(n => '<option value="' + n.id + '">' + n.name + ' (' + n.ip_address + ')</option>').join('');
                            }

                            // 2. Render Emulated Devices
                            const devsTbody = document.getElementById('emul_devs_tbody');
                            const devs = devsRes.devices || [];

                            if (devs.length === 0) {
                                const noDevText = window.t ? window.t('emulated.no_devices', 'No emulated devices created. Create one above.') : 'No emulated devices created. Create one above.';
                                devsTbody.innerHTML = '<tr><td colspan="7" class="text-white-50 text-center py-2" data-i18n="emulated.no_devices">' + noDevText + '</td></tr>';
                            } else {
                                const sendTelText = window.t ? window.t('emulated.btn_send_telemetry', 'Send Telemetry') : 'Send Telemetry';
                                devsTbody.innerHTML = devs.map(d => '<tr>' +
                                    '<td><strong class="text-white">' + d.serial_no + '</strong></td>' +
                                    '<td>' + (d.esp32_name || '-') + ' <span class="text-white-50">(<code>' + (d.esp32_ip || '-') + '</code>)</span></td>' +
                                    '<td>Home #' + d.home_id + '</td>' +
                                    '<td><span class="badge bg-info text-dark fw-semibold">' + d.mode + '</span></td>' +
                                    '<td><code>' + d.ipv6_address + '</code></td>' +
                                    '<td><span class="badge ' + (d.pairing_state === 'PAIRED' ? 'bg-success' : 'bg-warning text-dark') + '">' + d.pairing_state + '</span></td>' +
                                    '<td class="table-actions-cell">' +
                                        '<div class="d-inline-flex align-items-center gap-1 justify-content-end">' +
                                            '<button class="btn-action-telemetry" id="tel_btn_' + d.serial_no + '" data-serial="' + d.serial_no + '" onclick="triggerTelemetry(this.dataset.serial)"><i class="bi bi-broadcast"></i> <span data-i18n="emulated.btn_send_telemetry">' + sendTelText + '</span></button>' +
                                            '<button class="btn-action-danger" data-serial="' + d.serial_no + '" onclick="deleteEmulatedDevice(this.dataset.serial)" title="Delete Device"><i class="bi bi-trash"></i></button>' +
                                        '</div>' +
                                    '</td>' +
                                '</tr>').join('');
                            }
                            if (window.applyTranslations) {
                                window.applyTranslations(nodesTbody);
                                window.applyTranslations(devsTbody);
                            }
                        } catch (e) {
                            console.error('Emulated load error:', e);
                        }
                    }

                    function copyNodeApiKey(btn) {
                        const key = btn.getAttribute('data-key') || '';
                        if (!key) return;
                        navigator.clipboard.writeText(key).then(() => {
                            alert(window.t ? window.t('emulated.key_copied', 'API Key copied to clipboard!') : 'API Key copied to clipboard!');
                        });
                    }

                    async function addEsp32Node() {
                        const name = document.getElementById('emul_node_name').value.trim();
                        const ip_address = document.getElementById('emul_node_ip').value.trim();
                        const api_port = parseInt(document.getElementById('emul_node_port').value, 10) || 80;
                        const api_key = document.getElementById('emul_node_key') ? document.getElementById('emul_node_key').value.trim() : '';

                        if (!name || !ip_address) return alert(window.t ? window.t('emulated.enter_node_details', 'Enter node name and IP address') : 'Enter node name and IP address');

                        const res = await apiCall('/setup/emulated/nodes', 'POST', { name, ip_address, api_port, api_key });
                        if (res && res.success) {
                            document.getElementById('emul_node_name').value = '';
                            document.getElementById('emul_node_ip').value = '';
                            if (document.getElementById('emul_node_key')) document.getElementById('emul_node_key').value = '';
                            loadEmulatedData();
                        }
                    }

                    async function editNodeApiKey(id, currentKey) {
                        const promptMsg = window.t ? window.t('emulated.prompt_api_key', 'Enter API key for this ESP32 node (must match api_key in tado_emulator.yaml, leave empty to disable):') : 'Enter API key for this ESP32 node (must match api_key in tado_emulator.yaml, leave empty to disable):';
                        const newKey = prompt(promptMsg, currentKey || '');
                        if (newKey === null) return;
                        const res = await apiCall('/setup/emulated/nodes/' + id + '/api-key', 'POST', { api_key: newKey.trim() });
                        if (res && res.success) {
                            loadEmulatedData();
                        }
                    }

                    async function deleteEsp32Node(id) {
                        if (!confirm(window.t ? window.t('emulated.confirm_delete_node', 'Delete this ESP32 hardware node?') : 'Delete this ESP32 hardware node?')) return;
                        await apiCall('/setup/emulated/nodes/' + id, 'DELETE');
                        loadEmulatedData();
                    }

                    async function clearEsp32Nvs(nodeId) {
                        if (!confirm(window.t ? window.t('emulated.confirm_clear_nvs', 'Clear all emulated devices and pairings from ESP32 NVRAM?') : 'Clear all emulated devices and pairings from ESP32 NVRAM?')) return;
                        const res = await apiCall('/setup/emulated/nodes/' + nodeId + '/clear-nvs', 'POST');
                        if (res && res.success) {
                            alert('✓ ' + (res.message || 'ESP32 NVRAM cleared'));
                            loadEmulatedData();
                        }
                    }

                    async function rebootEsp32Node(nodeId) {
                        if (!confirm(window.t ? window.t('emulated.confirm_reboot', 'Reboot this ESP32 hardware node? Active connections will momentarily drop.') : 'Reboot this ESP32 hardware node? Active connections will momentarily drop.')) return;
                        const btn = document.getElementById('reboot_btn_' + nodeId);
                        const origHtml = btn ? btn.innerHTML : '';
                        if (btn) {
                            btn.disabled = true;
                            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Rebooting...';
                        }
                        const res = await apiCall('/setup/emulated/nodes/' + nodeId + '/reboot', 'POST');
                        if (res && res.success) {
                            setTimeout(loadEmulatedData, 4000);
                        } else {
                            if (btn) {
                                btn.disabled = false;
                                btn.innerHTML = origHtml;
                            }
                        }
                    }

                    async function createEmulatedDevice() {
                        const esp32_node_id = document.getElementById('emul_dev_node').value;
                        const home_id = document.getElementById('emul_dev_home').value;
                        const serial_no = document.getElementById('emul_dev_serial').value.trim();

                        if (!esp32_node_id || !home_id) return alert(window.t ? window.t('emulated.select_node_and_home', 'Select target ESP32 node and home') : 'Select target ESP32 node and home');

                        const res = await apiCall('/setup/emulated/devices', 'POST', {
                            esp32_node_id, home_id, serial_no
                        });

                        if (res && res.success) {
                            alert(window.t ? window.t('emulated.dev_created', 'Emulated device created! Auto-pairing initiated on Internet Bridge and ESP32 node.') : 'Emulated device created! Auto-pairing initiated on Internet Bridge and ESP32 node.');
                            document.getElementById('emul_dev_serial').value = '';
                            loadEmulatedData();
                        }
                    }

                    async function deleteEmulatedDevice(serialNo) {
                        const prefix = window.t ? window.t('emulated.confirm_delete_dev', 'Delete emulated device ') : 'Delete emulated device ';
                        const suffix = window.t ? window.t('emulated.confirm_delete_dev_suffix', '? This will send unassociation config over RF and erase ESP32 NVRAM.') : '? This will send unassociation config over RF and erase ESP32 NVRAM.';
                        if (!confirm(prefix + serialNo + suffix)) return;
                        await apiCall('/setup/emulated/devices/' + serialNo, 'DELETE');
                        loadEmulatedData();
                    }

                    async function triggerTelemetry(serialNo) {
                        const btn = document.getElementById('tel_btn_' + serialNo);
                        const origHtml = btn ? btn.innerHTML : '';
                        if (btn) {
                            btn.disabled = true;
                            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Sending...';
                        }
                        try {
                            const res = await apiCall('/setup/emulated/devices/' + serialNo + '/telemetry', 'POST', {
                                temp_celsius: 21.5,
                                humidity_percent: 48.5,
                                battery_mv: serialNo.startsWith('RU') ? 4500 : 3000
                            });
                            if (btn) {
                                if (res && res.success) {
                                    btn.innerHTML = '<i class="bi bi-check-lg text-success"></i> Sent!';
                                    setTimeout(() => { if (btn) { btn.innerHTML = origHtml; btn.disabled = false; } }, 2000);
                                } else {
                                    btn.innerHTML = '<i class="bi bi-x-lg text-danger"></i> Failed';
                                    setTimeout(() => { if (btn) { btn.innerHTML = origHtml; btn.disabled = false; } }, 2000);
                                }
                            }
                        } catch (err) {
                            if (btn) {
                                btn.innerHTML = '<i class="bi bi-x-lg text-danger"></i> Error';
                                setTimeout(() => { if (btn) { btn.innerHTML = origHtml; btn.disabled = false; } }, 2000);
                            }
                        }
                    }

                    // Tab Persistence
                    document.addEventListener('DOMContentLoaded', () => {
                        const lastTab = localStorage.getItem('activeTab');
                        if (lastTab) {
                            const tabTarget = document.querySelector('#' + lastTab);
                            if (tabTarget) {
                                bootstrap.Tab.getOrCreateInstance(tabTarget).show();
                            }
                        }

                        document.querySelectorAll('button[data-bs-toggle="tab"]').forEach(tabEl => {
                            tabEl.addEventListener('shown.bs.tab', event => {
                                localStorage.setItem('activeTab', event.target.id);
                                if (event.target.id === 'tab-zones') loadZones();
                                if (event.target.id === 'tab-tuning') loadTuning();
                                if (event.target.id === 'tab-settings') { loadSettings(); loadMqttSettings(); }
                                if (event.target.id === 'tab-emulated') loadEmulatedData();
                                if (event.target.id === 'tab-snapshot') loadSnapshotData();
                            });
                        });

                        // Initial load for current tab
                        if (lastTab === 'tab-zones') loadZones();
                        if (lastTab === 'tab-tuning') loadTuning();
                        if (lastTab === 'tab-settings') { loadSettings(); loadMqttSettings(); }
                        if (lastTab === 'tab-emulated') loadEmulatedData();
                        if (lastTab === 'tab-snapshot') loadSnapshotData();
                    });
                </script>
            </body>
            </html>
        `);
    } catch (err) {
        _log('error', err.stack);
        res.status(500).send('Dashboard error');
    }
});

module.exports = router;
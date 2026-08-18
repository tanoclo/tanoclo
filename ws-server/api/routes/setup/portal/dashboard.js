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

const router = express.Router();
const _log = getLogger('setup-api');

// --- Routes ---
router.get('/dashboard', adminAuth, async (req, res) => {
    try {
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
            SELECT u.*, u.home_id as home_ids
            FROM users u
        `);

        const [admins] = await pool.execute('SELECT * FROM admin_users WHERE id = ?', [req.admin.id]);
        const admin = admins[0];

        res.send(`
            <html>
            <head>
                <title>Setup Dashboard</title>
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
                    
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
                    
                    .form-select-sm { background-color: #1a1a1a !important; border-color: rgba(255, 255, 255, 0.1) !important; color: #fff !important; }
                    .font-monospace { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace !important; }
                    pre { background: #000; padding: 15px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); }
                </style>
            </head>
            <body>
                <nav class="navbar navbar-dark bg-primary px-4 mb-4">
                    <div class="d-flex align-items-center">
                        <span class="navbar-brand">TaNoClo Setup Portal</span>
                        <a href="/api/docs" target="_blank" class="nav-link text-light ms-3 small" style="text-decoration: underline;">API Reference</a>
                    </div>
                    <a href="/setup/logout" class="btn btn-outline-light btn-sm">Logout</a>
                </nav>
                <div class="container pb-5">
                    <ul class="nav nav-tabs mb-4" id="setupTabs" role="tablist">
                        <li class="nav-item"><button class="nav-link active" id="tab-homes" data-bs-toggle="tab" data-bs-target="#homes">Homes</button></li>
                        <li class="nav-item" style="display: none;"><button class="nav-link" id="tab-devices" data-bs-toggle="tab" data-bs-target="#devices">Devices</button></li>
                        <li class="nav-item" style="display: none;"><button class="nav-link" id="tab-zones" data-bs-toggle="tab" data-bs-target="#zones">Zones</button></li>
                        <li class="nav-item" style="display: none;"><button class="nav-link" id="tab-tuning" data-bs-toggle="tab" data-bs-target="#tuning">Actuator Limits</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-whitelist" data-bs-toggle="tab" data-bs-target="#whitelist">Whitelist</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-users" data-bs-toggle="tab" data-bs-target="#users">Users</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-security" data-bs-toggle="tab" data-bs-target="#security">Security</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-decoder" data-bs-toggle="tab" data-bs-target="#decoder">Decoder</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-settings" data-bs-toggle="tab" data-bs-target="#settings">Settings</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-emulated" data-bs-toggle="tab" data-bs-target="#emulated">Emulated Devices</button></li>
                        <li class="nav-item"><button class="nav-link" id="tab-snapshot" data-bs-toggle="tab" data-bs-target="#snapshot">State Snapshot</button></li>
                    </ul>

                    <div class="tab-content">
                        <!-- Homes Tab -->
                        <div class="tab-pane fade show active" id="homes">
                            <h3>Managed Homes</h3>
                            <table class="table table-dark mt-3">
                                <thead><tr><th>ID</th><th>Name</th><th>Devices</th><th>IB Serial</th><th>Admin User</th><th>Actions</th></tr></thead>
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
                                            <td>${h.device_count} (${h.zone_count} Zones)</td>
                                            <td>
                                                ${h.ib_serial || '-'}
                                                ${h.ib_serial ? `<button class="btn btn-sm btn-outline-success ms-1 py-0 px-1" title="Add to Whitelist" onclick="addToWhitelist('device', '${h.ib_serial}')">+</button>` : ''}
                                            </td>
                                            <td>
                                                <select onchange="changeHomeAdmin(${h.id}, this.value)" class="form-select form-select-sm bg-dark text-white border-secondary">
                                                    ${options || '<option value="">No Users</option>'}
                                                </select>
                                            </td>
                                            <td>
                                                <button class="btn btn-warning btn-sm" onclick="resetHome(${h.id})">Reset</button>
                                                <button class="btn btn-danger btn-sm" onclick="deleteHome(${h.id})">Del</button>
                                            </td>
                                        </tr>
                                        <tr class="home-row-config">
                                            <td colspan="6">
                                                <div class="proxy-pills-container">
                                                    <div class="form-switch proxy-pill">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="proxy_${h.id}" ${h.is_proxied ? 'checked' : ''} onchange="toggleProxy(${h.id}, this.checked ? 1 : 0)">
                                                        <label class="form-check-label" for="proxy_${h.id}">Proxy to Cloud</label>
                                                    </div>
                                                    <div class="form-switch proxy-pill ${!h.is_proxied ? 'opacity-50' : ''}">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="log_${h.id}" ${h.proxy_logging ? 'checked' : ''} onchange="toggleProxyLog(${h.id}, this.checked ? 1 : 0)" ${!h.is_proxied ? 'disabled' : ''}>
                                                        <label class="form-check-label" for="log_${h.id}">Traffic Logging</label>
                                                    </div>
                                                    <div class="form-switch proxy-pill ${!h.is_proxied ? 'opacity-50' : ''}">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="allow_cmds_${h.id}" ${h.allow_commands_in_proxy ? 'checked' : ''} onchange="toggleCommandsInProxy(${h.id}, this.checked ? 1 : 0)" ${!h.is_proxied ? 'disabled' : ''}>
                                                        <label class="form-check-label" for="allow_cmds_${h.id}">Commands in Proxy</label>
                                                    </div>
                                                    <div class="form-switch proxy-pill">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="zcro_${h.id}" ${h.zone_config_readonly ? 'checked' : ''} onchange="toggleZoneConfigReadonly(${h.id}, this.checked ? 1 : 0)">
                                                        <label class="form-check-label" for="zcro_${h.id}">Config Readonly</label>
                                                    </div>
                                                    <div class="form-switch proxy-pill">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="dev_bypass_${h.id}" ${h.dev_bypass ? 'checked' : ''} onchange="toggleDevBypass(${h.id}, this.checked ? 1 : 0)">
                                                        <label class="form-check-label" for="dev_bypass_${h.id}">Dev Bypass (DB only)</label>
                                                    </div>
                                                    <div class="form-switch proxy-pill">
                                                        <input class="form-check-input" type="checkbox" role="switch" id="ha_${h.id}" ${h.ha_discovery_enabled ? 'checked' : ''} onchange="toggleHaDiscovery(${h.id}, this.checked ? 1 : 0)">
                                                        <label class="form-check-label" for="ha_${h.id}">HA Discovery</label>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    </tbody>
                                        `;
        }).join('')}
                            </table>

                            <div class="mt-4 border-top pt-4">
                                <h4>Seed from Tado</h4>
                                <button class="btn btn-success px-4" onclick="startSeeding()">Start Tado Import</button>
                                <div id="seedStatus" class="mt-2"></div>
                            </div>
                        </div>

                        <!-- Devices Tab -->
                        <div class="tab-pane fade" id="devices">
                            <h3>Devices & Battery Health</h3>
                            <table class="table table-dark table-hover mt-3">
                                <thead><tr><th>Serial</th><th>Type</th><th>Home</th><th>Battery</th><th>Chemistry</th><th>Firmware</th></tr></thead>
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
                                                ` : '<span style="color: #666">Unknown</span>'}
                                            </td>
                                            <td>
                                                <select onchange="updateBatteryType('${d.serial_no}', this.value)" class="form-select form-select-sm bg-dark text-white border-secondary">
                                                    <option value="alkaline" ${d.battery_type === 'alkaline' ? 'selected' : ''}>Alkaline</option>
                                                    <option value="nimh" ${d.battery_type === 'nimh' ? 'selected' : ''}>NiMH</option>
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
                            <h3>Zone Management &amp; Offline Schedule</h3>
                            <p class="small text-white-50 mb-3">Enable or disable the VA offline (fallback) schedule per zone, and sync the current online schedule to the device&rsquo;s local storage.</p>
                            <div id="zones-loading" class="text-center py-4">
                                <div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div>
                            </div>
                            <table class="table table-dark table-hover mt-3" id="zones-table" style="display:none;">
                                <thead><tr>
                                    <th>Zone</th><th>Type</th><th>VA Devices</th><th>Timetable</th><th>Offline Schedule</th><th>Last Synced</th><th>Actions</th>
                                </tr></thead>
                                <tbody id="zones-table-body"></tbody>
                            </table>
                            <div id="zones-empty" class="text-white-50 text-center py-3" style="display:none;">No heating zones with VA devices found.</div>
                        </div>

                        <!-- Actuator Limits Tab -->
                        <div class="tab-pane fade" id="tuning">
                            <h3>Actuator Limits</h3>
                            <p class="small text-white-50 mb-4">
                                Configure mechanical actuator travel limits for Valve Actuators.
                            </p>

                            <div class="row g-4">
                                <!-- Device Actuator limits -->
                                <div class="col-12">
                                    <div class="card bg-dark border-secondary p-4">
                                        <h4 class="text-white">Valve Actuator Limits (/d/act)</h4>
                                        <p class="small text-white-50">
                                            Manually override stepper motor limits. 
                                            Fully Extended (Closed) steps define when the valve pin is completely pressed down. 
                                            Fully Retracted (Open) steps set the travel span. Drive Constant acts as mechanical correction.
                                        </p>
                                        <div id="tuning-devices-loading" class="text-center py-3">
                                            <div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div>
                                        </div>
                                        <div id="tuning-devices-container" style="display:none;">
                                            <table class="table table-dark table-hover align-middle">
                                                <thead>
                                                    <tr>
                                                        <th>Device (VA)</th>
                                                        <th>Home</th>
                                                        <th>Fully Extended (Limit Low)</th>
                                                        <th>Fully Retracted (Limit High)</th>
                                                        <th>Drive Constant</th>
                                                        <th>Current Position</th>
                                                        <th>Diagnostics</th>
                                                        <th>Action</th>
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
                                <h5 class="text-info">Actuator Limits Instructions</h5>
                                <div class="small text-white-50">
                                    <h6>Actuator Mechanical Travel Tuning:</h6>
                                    <ul>
                                        <li><b>Fully Extended (Limit Low):</b> The step count where the pin is pushed out as far as possible (valve closed). Typical values for VA02 are <b>2100-2600 steps</b>. Increasing this value drives the piston further out (closes tighter).</li>
                                        <li><b>Fully Retracted (Limit High):</b> The step count where the piston is retracted as far as possible (valve open). Typical values for VA02 are <b>1900-2500 steps</b>.</li>
                                        <li><b>Calibration Drive Constant:</b> An internal calibration reference value representing the baseline calibration offset. Typical values are <b>1700-1900 steps</b>.</li>
                                    </ul>
                                </div>
                            </div>
                        </div>

                        <!-- Whitelist Tab -->
                        <div class="tab-pane fade" id="whitelist">
                            <h3>WebSocket Whitelist</h3>
                            <div class="card bg-dark border-secondary p-3 mb-3 mt-3">
                                <h5 class="text-white small mb-2">Add New Whitelist Entry</h5>
                                <form onsubmit="submitWhitelist(event)" class="row g-2 align-items-end">
                                    <div class="col-md-3">
                                        <label class="form-label small text-info mb-1">Type</label>
                                        <select id="wl_type" class="form-select form-select-sm bg-dark text-white border-secondary">
                                            <option value="home">home</option>
                                            <option value="device">device</option>
                                        </select>
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label small text-info mb-1">Value (Home ID / Bridge Serial)</label>
                                        <input type="text" id="wl_value" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="e.g. 123456 or IB1234567890" required autocomplete="off">
                                    </div>
                                    <div class="col-md-3">
                                        <button type="submit" class="btn btn-primary btn-sm w-100">Add Entry</button>
                                    </div>
                                </form>
                            </div>
                            <table class="table table-dark table-hover mt-3">
                                <thead><tr><th>ID</th><th>Type</th><th>Value</th><th>Actions</th></tr></thead>
                                <tbody>
                                    ${whitelist.map(w => `
                                        <tr>
                                            <td>${w.id}</td>
                                            <td>${w.type}</td>
                                            <td><code>${w.value}</code></td>
                                            <td>
                                                <button class="btn btn-danger btn-sm" onclick="removeFromWhitelist(${w.id})">Remove</button>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>

                        <!-- Users Tab -->
                        <div class="tab-pane fade" id="users">
                            <h3>User Management</h3>
                            <table class="table table-dark table-hover mt-3">
                                <thead><tr><th>ID</th><th>Username</th><th>Name</th><th>Email</th><th>Homes</th><th>Actions</th></tr></thead>
                                <tbody>
                                    ${users.map(u => `
                                        <tr>
                                            <td>${u.id}</td>
                                            <td>${u.username}</td>
                                            <td>${u.name}</td>
                                            <td>${u.email}</td>
                                            <td>${u.home_ids || '-'}</td>
                                            <td>
                                                <button class="btn btn-sm btn-outline-warning" onclick="resetUserPass('${u.id}')">Pwd</button>
                                                <button class="btn btn-sm btn-outline-info" onclick="changeUserEmail('${u.id}')">Mail</button>
                                                <button class="btn btn-sm btn-outline-danger" onclick="deleteUser('${u.id}')">Del</button>
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
                                        <h4 class="text-white">Change Admin Password</h4>
                                        <div class="mb-3">
                                            <!-- Hidden username field to help autofill engines -->
                                            <input type="text" name="username" value="${admin.username}" style="display:none;" autocomplete="username">
                                            <label class="form-label small text-info">New Password</label>
                                            <input type="password" id="admin_new_pass" class="form-control bg-dark text-white border-secondary" autocomplete="new-password" placeholder="Enter new password">
                                        </div>
                                        <button class="btn btn-primary" onclick="updateAdminPass()">Update Password</button>
                                    </div>
                                </div>
                                <div class="col-md-6">
                                    <div class="card bg-dark border-secondary p-4 h-100">
                                        <h4 class="text-white">Two-Factor Authentication (2FA)</h4>
                                        <p class="small text-white-50">Current Status: <span class="badge ${admin.totp_secret ? 'bg-success' : 'bg-warning'}">${admin.totp_secret ? 'Enabled' : 'Disabled'}</span></p>
                                        <div class="mb-3">
                                            <label class="form-label small text-info">Update 2FA Secret (Base32)</label>
                                            <div class="input-group">
                                                <input type="text" id="admin_totp_secret" class="form-control bg-dark text-white border-secondary" placeholder="Click 'Gen' or enter a secret" autocomplete="off">
                                                <button class="btn btn-outline-info" onclick="generateTotpSecret()" title="Generate new random secret">Gen</button>
                                            </div>
                                            <div class="form-text text-white-50 small mt-2">
                                                To set or rotate your 2FA, generate or enter a new Base32 secret and update. 
                                                <strong>Note: Current secret is hidden for privacy.</strong>
                                            </div>
                                        </div>
                                        <button class="btn btn-primary" onclick="updateAdminTotp()">Update 2FA Secret</button>
                                        <button class="btn btn-link btn-sm text-danger h6 p-0 mt-3" onclick="disableAdminTotp()">Disable 2FA</button>
                                    </div>
                                </div>
                            </div>
                    </div>

                    <!-- Decoder Tab -->
                    <div class="tab-pane fade" id="decoder">
                        <h3>Message Decoder</h3>
                        <div class="row">
                            <div class="col-12 mb-4">
                                <div class="card bg-dark border-secondary p-4">
                                    <h4 class="text-white">Decode WebSocket / CoAP Message</h4>
                                    <p class="small text-white-50">Paste a raw hex message from debug logs to see a detailed breakdown of the Bridge Frame, CoAP layer, and TLV payload.</p>
                                    <div class="mb-3">
                                        <label for="decoder_cache_select" class="form-label small text-info">Load from Cache (Last Downlink)</label>
                                        <div class="input-group">
                                            <select id="decoder_cache_select" class="form-select form-select-sm bg-dark text-white border-secondary">
                                                <option value="">-- No messages cached --</option>
                                            </select>
                                            <button class="btn btn-outline-info btn-sm" onclick="refreshCache()">Refresh</button>
                                        </div>
                                    </div>
                                    <div class="mb-3">
                                        <label for="decoder_hex" class="form-label small text-info">Raw Hex Message</label>
                                        <textarea id="decoder_hex" class="form-control bg-dark text-white border-secondary font-monospace" rows="5" placeholder="000110fd000000000000000000000000000001..."></textarea>
                                    </div>
                                    <button class="btn btn-primary" onclick="decodeHex()">Decode Message</button>
                                </div>
                            </div>
                        </div>
                        <div id="decoder_results" style="display:none;">
                            <div class="row">
                                <div class="col-md-6 mb-4">
                                    <div id="bridge_card" class="card bg-dark border-info p-3 h-100" style="display:none;">
                                        <h5 class="text-info">WS Bridge Frame</h5>
                                        <div id="bridge_info" class="small"></div>
                                    </div>
                                </div>
                                <div class="col-md-6 mb-4">
                                    <div id="coap_card" class="card bg-dark border-primary p-3 h-100" style="display:none;">
                                        <h5 class="text-primary">CoAP Message</h5>
                                        <div id="coap_info" class="small"></div>
                                    </div>
                                </div>
                            </div>
                            <div id="tlv_card" class="card bg-dark border-success p-3 mb-4" style="display:none;">
                                <h5 class="text-success">TLV Payload</h5>
                                <div class="table-responsive">
                                    <table class="table table-dark table-sm small mt-2">
                                        <thead><tr><th>ID</th><th>Name</th><th>Value</th><th>Unit</th><th>Raw</th></tr></thead>
                                        <tbody id="tlv_table_body"></tbody>
                                    </table>
                                </div>
                            </div>
                            <div class="card bg-dark border-secondary p-3">
                                <h5 class="text-secondary">Full JSON Result</h5>
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
                                    <h4 class="text-white mb-3">Server Settings</h4>
                                    <div class="mb-3">
                                        <label class="form-label small text-info">Log Level</label>
                                        <select id="settings_log_level" class="form-select form-select-sm bg-dark text-white border-secondary">
                                            <option value="debug">debug</option>
                                            <option value="info">info</option>
                                            <option value="warn">warn</option>
                                            <option value="error">error</option>
                                        </select>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info">JWT Secret</label>
                                        <div class="input-group">
                                            <input type="password" id="settings_jwt_secret" class="form-control bg-dark text-white border-secondary font-monospace" readonly>
                                            <button class="btn btn-outline-secondary btn-sm" onclick="toggleJwtVisibility()" title="Show/Hide" id="jwt_toggle_btn">👁</button>
                                            <button class="btn btn-outline-warning btn-sm" onclick="generateJwtSecret()" title="Generate new">Gen</button>
                                        </div>
                                        <div class="form-text text-white-50 small mt-1">Changing the JWT secret will invalidate all existing sessions.</div>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info">Device Measurements Retention (Days)</label>
                                        <input type="number" id="settings_cleanup_device_measurements_days" class="form-control form-control-sm bg-dark text-white border-secondary" min="1" required>
                                        <div class="form-text text-white-50 small mt-1">How many days of device measurements to keep. Default: 30.</div>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info">Zone Measurements Retention (Days)</label>
                                        <input type="number" id="settings_cleanup_zone_measurements_days" class="form-control form-control-sm bg-dark text-white border-secondary" min="1" required>
                                        <div class="form-text text-white-50 small mt-1">How many days of zone measurements to keep. Default: 390 (13 months).</div>
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info">Home Weather Retention (Days)</label>
                                        <input type="number" id="settings_cleanup_home_weather_days" class="form-control form-control-sm bg-dark text-white border-secondary" min="1" required>
                                        <div class="form-text text-white-50 small mt-1">How many days of home weather data to keep. Default: 390 (13 months).</div>
                                    </div>
                                    <div class="form-check form-switch mb-3">
                                        <input class="form-check-input" type="checkbox" role="switch" id="settings_swagger_enabled">
                                        <label class="form-check-label small text-info" for="settings_swagger_enabled">Enable OpenAPI/Swagger Documentation</label>
                                        <div class="form-text text-white-50 small mt-1">Make interactive Swagger docs available at /api/docs (guarded by setup admin authentication).</div>
                                    </div>
                                    <hr class="border-secondary">
                                    <h5 class="text-white mb-2">Frontend OTA Updates</h5>
                                    <div class="form-check form-switch mb-3">
                                        <input class="form-check-input" type="checkbox" role="switch" id="settings_ota_auto_update">
                                        <label class="form-check-label small text-info" for="settings_ota_auto_update">Auto-update Frontend</label>
                                        <div class="form-text text-white-50 small mt-1">Automatically download and extract the latest frontend web assets from the GitHub OTA branch on startup and hourly. If disabled, existing frontend files are kept. Overruled once if no frontend files exist.</div>
                                    </div>
                                    <div class="d-flex gap-2 mb-4 align-items-center">
                                        <button class="btn btn-outline-info btn-sm" id="ota_sync_btn" onclick="triggerOtaSync()">⟳ Sync Frontend Now</button>
                                        <span id="ota_sync_status" class="small"></span>
                                    </div>
                                    <div class="d-flex gap-2 mb-4">
                                        <button class="btn btn-primary btn-sm" onclick="saveServerSettings()">Save Settings</button>
                                    </div>
                                    <hr class="border-secondary">
                                    <div>
                                        <h5 class="text-white mb-2">Server Control</h5>
                                        <p class="small text-white-50 mb-2">Restart the Node.js server. Docker will automatically restart the container. All WebSocket connections will be dropped and IB devices will reconnect.</p>
                                        <button class="btn btn-danger btn-sm" id="restart_btn" onclick="restartServer()">⟳ Restart Server</button>
                                        <div id="restart_status" class="mt-2 small"></div>
                                    </div>
                                </div>
                            </div>

                            <!-- MQTT Configuration -->
                            <div class="col-md-6">
                                <div class="card bg-dark border-secondary p-4 h-100">
                                    <h4 class="text-white mb-3">MQTT Configuration</h4>
                                    <div class="row g-2 mb-2">
                                        <div class="col-8">
                                            <label class="form-label small text-info">Broker Host</label>
                                            <input type="text" id="mqtt_host" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="e.g. 192.168.1.100">
                                        </div>
                                        <div class="col-4">
                                            <label class="form-label small text-info">Port</label>
                                            <input type="number" id="mqtt_port" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="1883" value="1883">
                                        </div>
                                    </div>
                                    <div class="row g-2 mb-2">
                                        <div class="col-6">
                                            <label class="form-label small text-info">Username</label>
                                            <input type="text" id="mqtt_user" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="mqtt_user">
                                        </div>
                                        <div class="col-6">
                                            <label class="form-label small text-info">Password</label>
                                            <input type="password" id="mqtt_password" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="••••••">
                                        </div>
                                    </div>
                                    <div class="form-check form-switch d-flex justify-content-between align-items-center px-0 my-3 py-2 px-2 rounded" style="background: rgba(255,255,255,0.03);">
                                        <label class="form-check-label small text-white" for="mqtt_ha_discovery">Home Assistant Discovery</label>
                                        <input class="form-check-input ms-0" type="checkbox" role="switch" id="mqtt_ha_discovery">
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label small text-info">HA MQTT Path</label>
                                        <input type="text" id="mqtt_ha_path" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="homeassistant" value="homeassistant">
                                    </div>
                                    <div class="d-flex gap-2">
                                        <button class="btn btn-primary btn-sm" onclick="saveMqttSettings()">Save MQTT</button>
                                        <button class="btn btn-outline-info btn-sm" id="mqtt_test_btn" onclick="testMqttConnection()">Test Connection</button>
                                    </div>
                                    <div id="mqtt_status" class="mt-2 small"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- State Snapshot Tab -->
                    <div class="tab-pane fade" id="snapshot">
                        <h3>State Snapshot</h3>
                        <p class="small text-white-50 mb-3">
                            Capture original Tado cloud configuration while in proxy mode.
                            Use snapshots to revert devices, zones, and circuits to their original state after making changes in TaNoClo.
                        </p>

                        <!-- Home Selector + Capture Controls -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <div class="row align-items-end g-3">
                                <div class="col-md-4">
                                    <label class="form-label small text-info">Home</label>
                                    <select id="snap_home" class="form-select form-select-sm bg-dark text-white border-secondary" onchange="loadSnapshotData()">
                                        ${homes.map(h => '<option value="' + h.id + '">' + h.name + ' (' + h.id + ')</option>').join('')}
                                    </select>
                                </div>
                                <div class="col-md-8 d-flex gap-2">
                                    <button class="btn btn-success btn-sm" id="snap_start_btn" onclick="startSnapshotCapture()">▶ Start Capture</button>
                                    <button class="btn btn-warning btn-sm" id="snap_stop_btn" onclick="stopSnapshotCapture()" disabled>⏹ Stop Capture</button>
                                    <span id="snap_status" class="badge bg-secondary align-self-center ms-2">Not Started</span>
                                </div>
                            </div>
                        </div>

                        <!-- Progress Matrix -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <h5 class="text-white mb-2">Capture Progress</h5>
                            <div class="progress mb-3" style="height: 8px;">
                                <div class="progress-bar bg-success" id="snap_progress_bar" style="width: 0%"></div>
                            </div>
                            <div class="small text-white-50 mb-3" id="snap_progress_text">No capture active</div>
                            <div class="table-responsive">
                                <table class="table table-dark table-hover table-sm" id="snap_progress_table" style="display:none;">
                                    <thead><tr>
                                        <th>Entity</th><th>Type</th><th>Path</th><th>Status</th><th>Captured</th>
                                    </tr></thead>
                                    <tbody id="snap_progress_tbody"></tbody>
                                </table>
                            </div>
                        </div>

                        <!-- Snapshot History -->
                        <div class="card bg-dark border-secondary p-3">
                            <h5 class="text-white mb-2">Snapshot History</h5>
                            <div id="snap_history_loading" class="text-center py-2">
                                <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
                            </div>
                            <div class="table-responsive">
                                <table class="table table-dark table-hover table-sm" id="snap_history_table" style="display:none;">
                                    <thead><tr>
                                        <th>ID</th><th>Created</th><th>Status</th><th>Size</th><th>Actions</th>
                                    </tr></thead>
                                    <tbody id="snap_history_tbody"></tbody>
                                </table>
                            </div>
                            <div class="mt-3 border-top border-secondary pt-3">
                                <h6 class="text-white-50 small">Import Snapshot</h6>
                                <div class="input-group input-group-sm">
                                    <input type="file" class="form-control form-control-sm bg-dark text-white border-secondary" id="snap_import_file" accept=".json">
                                    <button class="btn btn-outline-info btn-sm" onclick="importSnapshot()">Import</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Emulated Devices & ESP32 Nodes Tab -->
                    <div class="tab-pane fade" id="emulated">
                        <div class="d-flex justify-content-between align-items-center mb-3">
                            <div>
                                <h3>Emulated Devices &amp; ESP32 Nodes</h3>
                                <p class="small text-white-50 mb-0">Manage hardware ESP32 host nodes and emulated Tado Room Units (RU) in Wireless Temperature Sensor mode.</p>
                            </div>
                            <button class="btn btn-outline-info btn-sm" onclick="loadEmulatedData()">🔄 Refresh List</button>
                        </div>

                        <!-- Register ESP32 Hardware Node Card -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <h5 class="text-info">Register ESP32 Hardware Node</h5>
                            <div class="row g-2 align-items-end">
                                <div class="col-md-4">
                                    <label class="form-label small text-white-50">Node Name</label>
                                    <input type="text" id="emul_node_name" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="ESP32 Sniffer/Emulator 1">
                                </div>
                                <div class="col-md-4">
                                    <label class="form-label small text-white-50">IP Address</label>
                                    <input type="text" id="emul_node_ip" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="192.168.1.150">
                                </div>
                                <div class="col-md-2">
                                    <label class="form-label small text-white-50">API Port</label>
                                    <input type="number" id="emul_node_port" class="form-control form-control-sm bg-dark text-white border-secondary" value="80">
                                </div>
                                <div class="col-md-2">
                                    <button class="btn btn-primary btn-sm w-100" onclick="addEsp32Node()">+ Add Node</button>
                                </div>
                            </div>
                        </div>

                        <!-- ESP32 Hardware Nodes Table -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <h5 class="text-white">Active ESP32 Nodes</h5>
                            <div class="table-responsive">
                                <table class="table table-dark table-sm small align-middle mb-0">
                                    <thead><tr><th>ID</th><th>Node Name</th><th>IP Address</th><th>Port</th><th>Status</th><th>Last Seen</th><th>Actions</th></tr></thead>
                                    <tbody id="emul_nodes_tbody"><tr><td colspan="7" class="text-white-50">Loading nodes...</td></tr></tbody>
                                </table>
                            </div>
                        </div>

                        <!-- Create Emulated Device Card -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <h5 class="text-success">Create Emulated RU Device (Wireless Sensor Mode)</h5>
                            <div class="row g-2 align-items-end">
                                <div class="col-md-3">
                                    <label class="form-label small text-white-50">Target ESP32 Node</label>
                                    <select id="emul_dev_node" class="form-select form-select-sm bg-dark text-white border-secondary">
                                        <option value="">Select Node...</option>
                                    </select>
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label small text-white-50">Home Assignment</label>
                                    <select id="emul_dev_home" class="form-select form-select-sm bg-dark text-white border-secondary">
                                        ${homes.map(h => '<option value="' + h.id + '">' + h.name + ' (' + h.id + ')</option>').join('')}
                                    </select>
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label small text-white-50">Serial Number (Optional)</label>
                                    <input type="text" id="emul_dev_serial" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="Auto-generated if empty">
                                </div>
                                <div class="col-md-3">
                                    <button class="btn btn-success btn-sm w-100" onclick="createEmulatedDevice()">+ Create &amp; Auto-Pair</button>
                                </div>
                            </div>
                        </div>

                        <!-- Emulated Devices Table -->
                        <div class="card bg-dark border-secondary p-3 mb-4">
                            <h5 class="text-white">Emulated Devices Registry</h5>
                            <div class="table-responsive">
                                <table class="table table-dark table-sm small align-middle mb-0">
                                    <thead><tr><th>Serial No</th><th>ESP32 Host</th><th>Home</th><th>Mode</th><th>IPv6 Address</th><th>Pairing State</th><th>Actions</th></tr></thead>
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
                            alert('Operation failed: ' + e.message);
                            return null;
                        }
                    }

                    // Home Actions
                    async function toggleProxy(id, val) { await apiCall('/setup/homes/'+id+'/proxy', 'POST', { enabled: val }); location.reload(); }
                    async function toggleProxyLog(id, val) { await apiCall('/setup/homes/'+id+'/proxy-log', 'POST', { enabled: val }); location.reload(); }
                    async function toggleLogUpload(id, val) { await apiCall('/setup/homes/'+id+'/log-upload', 'POST', { enabled: val }); location.reload(); }
                    async function toggleCommandsInProxy(id, val) { await apiCall('/setup/homes/'+id+'/allow-commands-in-proxy', 'POST', { enabled: val }); location.reload(); }
                    async function toggleZoneConfigReadonly(id, val) { await apiCall('/setup/homes/'+id+'/zone-config-readonly', 'POST', { enabled: val }); location.reload(); }
                    async function toggleDevBypass(id, val) { await apiCall('/setup/homes/'+id+'/dev-bypass', 'POST', { enabled: val }); location.reload(); }
                    async function toggleHaDiscovery(id, val) { await apiCall('/setup/homes/'+id+'/ha-discovery', 'POST', { enabled: val }); location.reload(); }
                    async function resetHome(id) { if(confirm('Reset home config while preserving stats?')) { await apiCall('/setup/homes/'+id+'/reset'); location.reload(); } }
                    async function deleteHome(id) { if(confirm('DANGER: Fully delete home and ALL measurements?')) { await apiCall('/setup/homes/'+id+'/delete'); location.reload(); } }
                    async function changeHomeAdmin(homeId, adminUserId) { 
                        const result = await apiCall('/setup/homes/' + homeId + '/admin', 'POST', { adminUserId }); 
                        if (result && result.success) {
                            alert('Home admin updated successfully');
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
                    async function resetUserPass(id) { const p = prompt('New Password:'); if(p) await apiCall('/setup/users/'+id+'/password', 'POST', { password: p }); }
                    async function changeUserEmail(id) { const e = prompt('New Email:'); if(e) await apiCall('/setup/users/'+id+'/email', 'POST', { email: e }); location.reload(); }
                    async function deleteUser(id) { if(confirm('Delete user?')) { await apiCall('/setup/users/'+id, 'DELETE'); location.reload(); } }

                    // Admin Security
                    async function updateAdminPass() {
                        const password = document.getElementById('admin_new_pass').value;
                        if (!password) return alert('Enter a password');
                        
                        let totp = null;
                        if (confirm('Verify with 2FA code? (If 2FA is enabled, this is required)')) {
                            totp = prompt('Enter 6-digit 2FA code:');
                        }

                        const data = await apiCall('/setup/admin/password', 'POST', { password, totp });
                        if (data?.success) { alert('Password updated!'); document.getElementById('admin_new_pass').value = ''; }
                        else if (data?.error) alert('Error: ' + data.error);
                    }
                    function generateTotpSecret() {
                        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
                        let secret = '';
                        for (let i = 0; i < 16; i++) secret += chars.charAt(Math.floor(Math.random() * chars.length));
                        document.getElementById('admin_totp_secret').value = secret;
                        alert('New secret generated: ' + secret + '\\n\\nIMPORTANT: Add this to your authenticator app now. You will need a code from this new secret to confirm the update!');
                    }
                    async function updateAdminTotp() {
                        const secret = document.getElementById('admin_totp_secret').value;
                        if (!secret) return alert('Enter or generate a secret first');
                        if (secret.length < 8) return alert('Secret must be at least 8 characters');
                        
                        const totp = prompt('Enter 6-digit 2FA code from your NEW secret to confirm:');
                        if (!totp) return;

                        const data = await apiCall('/setup/admin/totp', 'POST', { secret, totp });
                        if (data?.success) { alert('2FA Secret updated and verified! Refreshing...'); location.reload(); }
                        else if (data?.error) alert('Error: ' + data.error);
                    }
                    async function disableAdminTotp() {
                        if (confirm('DANGER: This will disable 2FA for your admin account. Continue?')) {
                            const totp = prompt('Enter current 6-digit 2FA code to confirm disabling:');
                            if (!totp) return;

                            const data = await apiCall('/setup/admin/totp', 'POST', { secret: null, totp });
                            if (data?.success) { alert('2FA disabled!'); location.reload(); }
                            else if (data?.error) alert('Error: ' + data.error);
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
                            const vaCell = z.va_count > 0 ? z.va_count + ' VA' : '<span class="text-white-50">None</span>';
                            const ttCell = z.timetable_type || 'N/A';
                            const isVA = z.va_count > 0 && z.type !== 'HOT_WATER';

                            let offlineCell = '<span class="text-white-50 small">N/A</span>';
                            if (isVA) {
                                const chk = z.offline_schedule_enabled ? 'checked' : '';
                                const lblClass = z.offline_schedule_enabled ? 'text-success' : 'text-white-50';
                                const lblText = z.offline_schedule_enabled ? 'Enabled' : 'Disabled';
                                offlineCell = '<div class="form-check form-switch d-inline-block">' +
                                    '<input class="form-check-input" type="checkbox" role="switch" id="ofsched_' + z.id + '" ' + chk +
                                    ' onchange="toggleOfflineSchedule(' + z.home_id + ',' + z.id + ',this.checked)">' +
                                    '<label class="form-check-label small ' + lblClass + '" for="ofsched_' + z.id + '">' + lblText + '</label>' +
                                    '</div>';
                            }

                            let syncCell = '';
                            if (z.offline_schedule_synced_at) {
                                syncCell = '<span class="small text-success">' + new Date(z.offline_schedule_synced_at).toLocaleString() + '</span>';
                            } else {
                                syncCell = '<span class="small text-white-50">Never</span>';
                            }

                            let actionCell = '';
                            if (isVA) {
                                actionCell = '<button class="btn btn-sm btn-outline-primary" id="sync-btn-' + z.id + '" ' +
                                    'onclick="syncOfflineSchedule(' + z.home_id + ',' + z.id + ')">&#x21bb; Sync Now</button>';
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
                        table.style.display = 'table';
                    }

                    async function toggleOfflineSchedule(homeId, zoneId, enabled) {
                        const label = document.querySelector('label[for="ofsched_' + zoneId + '"]');
                        const checkbox = document.getElementById('ofsched_' + zoneId);
                        label.textContent = 'Pushing...';
                        label.className = 'form-check-label small text-warning';

                        const result = await apiCall('/setup/zones/' + zoneId + '/offline-schedule', 'POST', { homeId: homeId, enabled: enabled });
                        if (result && result.success) {
                            label.textContent = enabled ? 'Enabled' : 'Disabled';
                            label.className = 'form-check-label small ' + (enabled ? 'text-success' : 'text-white-50');
                        } else {
                            checkbox.checked = !enabled;
                            label.textContent = !enabled ? 'Enabled' : 'Disabled';
                            label.className = 'form-check-label small ' + (!enabled ? 'text-success' : 'text-white-50');
                        }
                    }

                    async function syncOfflineSchedule(homeId, zoneId) {
                        const btn = document.getElementById('sync-btn-' + zoneId);
                        const origHtml = btn.innerHTML;
                        btn.disabled = true;
                        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Syncing...';

                        const result = await apiCall('/setup/zones/' + zoneId + '/offline-schedule/sync', 'POST', { homeId: homeId });
                        btn.disabled = false;
                        if (result && result.success) {
                            btn.innerHTML = '&#x2713; Synced!';
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
                                const activeBadge = d.field_028c ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-secondary">Inactive</span>';

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
                                    '<td><button class="btn btn-sm btn-primary" onclick="saveActuatorLimits(\\\'' + d.serial_no + '\\\')">Save</button></td>' +
                                 '</tr>';
                            });
                            deviceTbody.innerHTML = deviceRows;
                            deviceContainer.style.display = 'block';
                        } else {
                            deviceTbody.innerHTML = '<tr><td colspan="7" class="text-center text-white-50">No Valve Actuators found</td></tr>';
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
                            alert('Actuator limits successfully pushed and saved! (MID: ' + result.mid + ')');
                            loadTuning();
                        } else {
                            alert('Failed to save actuator limits');
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
                        document.getElementById('settings_cleanup_device_measurements_days').value = data.cleanup_device_measurements_days || 30;
                        document.getElementById('settings_cleanup_zone_measurements_days').value = data.cleanup_zone_measurements_days || 390;
                        document.getElementById('settings_cleanup_home_weather_days').value = data.cleanup_home_weather_days || 390;
                        document.getElementById('settings_swagger_enabled').checked = !!data.swagger_enabled;
                        document.getElementById('settings_ota_auto_update').checked = data.ota_auto_update !== false;
                    }

                    async function saveServerSettings() {
                        const logLevel = document.getElementById('settings_log_level').value;
                        const jwtInput = document.getElementById('settings_jwt_secret');
                        const jwtSecret = jwtInput.readOnly ? null : jwtInput.value;
                        const deviceDays = parseInt(document.getElementById('settings_cleanup_device_measurements_days').value, 10);
                        const zoneDays = parseInt(document.getElementById('settings_cleanup_zone_measurements_days').value, 10);
                        const weatherDays = parseInt(document.getElementById('settings_cleanup_home_weather_days').value, 10);
                        const swaggerEnabled = document.getElementById('settings_swagger_enabled').checked;

                        if (isNaN(deviceDays) || deviceDays < 1) {
                            alert('Device measurements retention must be at least 1 day.');
                            return;
                        }
                        if (isNaN(zoneDays) || zoneDays < 1) {
                            alert('Zone measurements retention must be at least 1 day.');
                            return;
                        }
                        if (isNaN(weatherDays) || weatherDays < 1) {
                            alert('Home weather retention must be at least 1 day.');
                            return;
                        }

                        const body = {
                            log_level: logLevel,
                            cleanup_device_measurements_days: deviceDays,
                            cleanup_zone_measurements_days: zoneDays,
                            cleanup_home_weather_days: weatherDays,
                            swagger_enabled: swaggerEnabled,
                            ota_auto_update: document.getElementById('settings_ota_auto_update').checked
                        };
                        if (jwtSecret !== null && jwtSecret.length > 0) {
                            if (!confirm('WARNING: Changing the JWT secret will invalidate ALL existing sessions (app logins, setup portal cookies). Continue?')) return;
                            body.jwt_secret = jwtSecret;
                        }

                        const data = await apiCall('/setup/settings', 'POST', body);
                        if (data && data.success) {
                            alert('Settings saved! Configuration updated successfully.');
                            jwtInput.readOnly = true;
                            if (body.jwt_secret) {
                                alert('JWT Secret updated. You may need to re-login.');
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
                        if (!confirm('Are you sure you want to restart the server? All WebSocket connections will be dropped.')) return;
                        const btn = document.getElementById('restart_btn');
                        const status = document.getElementById('restart_status');
                        btn.disabled = true;
                        status.innerHTML = '<span class="text-warning">Sending restart command...</span>';

                        try {
                            await fetch('/setup/server/restart', { method: 'POST' }).catch(() => {});
                        } catch (e) { /* Expected - server is shutting down */ }

                        status.innerHTML = '<span class="text-info">Server is restarting... Auto-refreshing in 8 seconds.</span>';
                        let countdown = 8;
                        const interval = setInterval(() => {
                            countdown--;
                            status.innerHTML = '<span class="text-info">Server is restarting... Auto-refreshing in ' + countdown + 's</span>';
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
                            status.innerHTML = '<span class="text-success">MQTT settings saved!</span>';
                            setTimeout(() => { status.innerHTML = ''; }, 3000);
                        }
                    }

                    async function testMqttConnection() {
                        const btn = document.getElementById('mqtt_test_btn');
                        const status = document.getElementById('mqtt_status');
                        btn.disabled = true;
                        btn.textContent = 'Testing...';
                        status.innerHTML = '';

                        const body = {
                            host: document.getElementById('mqtt_host').value,
                            port: parseInt(document.getElementById('mqtt_port').value) || 1883,
                            user: document.getElementById('mqtt_user').value,
                            password: document.getElementById('mqtt_password').value
                        };

                        const data = await apiCall('/setup/mqtt/test', 'POST', body);
                        btn.disabled = false;
                        btn.textContent = 'Test Connection';
                        if (data && data.success) {
                            status.innerHTML = '<span class="text-success">✓ Connected successfully!</span>';
                        } else {
                            status.innerHTML = '<span class="text-danger">✗ Connection failed: ' + (data?.error || 'Unknown error') + '</span>';
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
                                text.textContent = 'No capture active. Start one or enable proxy mode.';
                                table.style.display = 'none';
                                startBtn.disabled = false;
                                stopBtn.disabled = true;
                                statusBadge.className = 'badge bg-secondary align-self-center ms-2';
                                statusBadge.textContent = 'Not Started';
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
                            statusBadge.textContent = isCapturing ? 'Capturing...' : data.status === 'complete' ? 'Complete' : 'Incomplete';

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
                        if (!confirm('Restore this snapshot? This will overwrite current TaNoClo configuration with the original Tado state. Commands will be queued with 2s delays.')) return;
                        const result = await apiCall('/setup/homes/' + homeId + '/snapshot/' + snapshotId + '/restore');
                        if (result) alert('Restore complete: ' + result.restored + ' commands sent.');
                    }

                    async function deleteSnapshot(homeId, snapshotId) {
                        if (!confirm('Delete this snapshot permanently?')) return;
                        await apiCall('/setup/homes/' + homeId + '/snapshot/' + snapshotId, 'DELETE');
                        loadSnapshotData();
                    }

                    async function importSnapshot() {
                        const homeId = document.getElementById('snap_home').value;
                        const fileInput = document.getElementById('snap_import_file');
                        if (!fileInput.files[0]) return alert('Select a file first');
                        const text = await fileInput.files[0].text();
                        try { JSON.parse(text); } catch(e) { return alert('Invalid JSON file'); }
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
                                nodesTbody.innerHTML = '<tr><td colspan="7" class="text-white-50 text-center py-2">No ESP32 hardware nodes registered. Add one above.</td></tr>';
                                nodeSelect.innerHTML = '<option value="">No nodes available</option>';
                            } else {
                                nodesTbody.innerHTML = nodes.map(n => '<tr>' +
                                    '<td>' + n.id + '</td>' +
                                    '<td><strong>' + n.name + '</strong></td>' +
                                    '<td><code>' + n.ip_address + '</code></td>' +
                                    '<td>' + n.api_port + '</td>' +
                                    '<td><span class="badge ' + (n.status === 'ONLINE' ? 'bg-success' : (n.status === 'OFFLINE' ? 'bg-danger' : 'bg-warning')) + '">' + n.status + '</span></td>' +
                                    '<td class="small text-white-50">' + (n.last_seen ? new Date(n.last_seen).toLocaleTimeString() : '-') + '</td>' +
                                    '<td><button class="btn btn-outline-danger btn-sm py-0 px-2" onclick="deleteEsp32Node(' + n.id + ')">Del</button></td>' +
                                '</tr>').join('');

                                nodeSelect.innerHTML = '<option value="">Select Node...</option>' +
                                    nodes.map(n => '<option value="' + n.id + '">' + n.name + ' (' + n.ip_address + ')</option>').join('');
                            }

                            // 2. Render Emulated Devices
                            const devsTbody = document.getElementById('emul_devs_tbody');
                            const devs = devsRes.devices || [];

                            if (devs.length === 0) {
                                devsTbody.innerHTML = '<tr><td colspan="7" class="text-white-50 text-center py-2">No emulated devices created. Create one above.</td></tr>';
                            } else {
                                devsTbody.innerHTML = devs.map(d => '<tr>' +
                                    '<td><strong>' + d.serial_no + '</strong></td>' +
                                    '<td>' + (d.esp32_name || '-') + ' (<code>' + (d.esp32_ip || '-') + '</code>)</td>' +
                                    '<td>Home #' + d.home_id + '</td>' +
                                    '<td><span class="badge bg-info">' + d.mode + '</span></td>' +
                                    '<td><code>' + d.ipv6_address + '</code></td>' +
                                    '<td><span class="badge ' + (d.pairing_state === 'PAIRED' ? 'bg-success' : 'bg-warning') + '">' + d.pairing_state + '</span></td>' +
                                    '<td>' +
                                        '<button class="btn btn-outline-info btn-sm py-0 px-2 me-1" data-serial="' + d.serial_no + '" onclick="triggerTelemetry(this.dataset.serial)">Send Telemetry</button>' +
                                        '<button class="btn btn-outline-danger btn-sm py-0 px-2" data-serial="' + d.serial_no + '" onclick="deleteEmulatedDevice(this.dataset.serial)">Del</button>' +
                                    '</td>' +
                                '</tr>').join('');
                            }
                        } catch (e) {
                            console.error('Emulated load error:', e);
                        }
                    }

                    async function addEsp32Node() {
                        const name = document.getElementById('emul_node_name').value.trim();
                        const ip_address = document.getElementById('emul_node_ip').value.trim();
                        const api_port = parseInt(document.getElementById('emul_node_port').value, 10) || 80;

                        if (!name || !ip_address) return alert('Enter node name and IP address');

                        const res = await apiCall('/setup/emulated/nodes', 'POST', { name, ip_address, api_port });
                        if (res && res.success) {
                            document.getElementById('emul_node_name').value = '';
                            document.getElementById('emul_node_ip').value = '';
                            loadEmulatedData();
                        }
                    }

                    async function deleteEsp32Node(id) {
                        if (!confirm('Delete this ESP32 hardware node?')) return;
                        await apiCall('/setup/emulated/nodes/' + id, 'DELETE');
                        loadEmulatedData();
                    }

                    async function createEmulatedDevice() {
                        const esp32_node_id = document.getElementById('emul_dev_node').value;
                        const home_id = document.getElementById('emul_dev_home').value;
                        const serial_no = document.getElementById('emul_dev_serial').value.trim();

                        if (!esp32_node_id || !home_id) return alert('Select target ESP32 node and home');

                        const res = await apiCall('/setup/emulated/devices', 'POST', {
                            esp32_node_id, home_id, serial_no
                        });

                        if (res && res.success) {
                            alert('Emulated device created! Auto-pairing initiated on Internet Bridge and ESP32 node.');
                            document.getElementById('emul_dev_serial').value = '';
                            loadEmulatedData();
                        }
                    }

                    async function deleteEmulatedDevice(serialNo) {
                        if (!confirm('Delete emulated device ' + serialNo + '? This will send unassociation config over RF and erase ESP32 NVRAM.')) return;
                        await apiCall('/setup/emulated/devices/' + serialNo, 'DELETE');
                        loadEmulatedData();
                    }

                    async function triggerTelemetry(serialNo) {
                        const res = await apiCall('/setup/emulated/devices/' + serialNo + '/telemetry', 'POST', {
                            temp_celsius: 21.5,
                            humidity_percent: 48.5,
                            battery_mv: 3050
                        });
                        if (res && res.success) {
                            alert('Telemetry push triggered for ' + serialNo);
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
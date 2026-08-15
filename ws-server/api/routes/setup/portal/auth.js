/**
 * @file api/routes/setup/portal/auth.js
 * @brief Authentication routes for the admin setup portal.
 * 
 * Supports password validation checks, two-factor TOTP verification, and jwt-signed
 * cookie generations for admin portal access.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../../../../lib/db');
const config = require('../../../../lib/config');
const { getLogger } = require('../../../../lib/logger');

const router = express.Router();
const _log = getLogger('setup-api');

// --- TOTP helper (lines 22-65) ---
const TOTP = {
    verify(secret, code, window = 1) {
        if (!secret) return true;
        const timestamp = Math.floor(Date.now() / 1000);
        for (let i = -window; i <= window; i++) {
            if (this.getCode(secret, timestamp + (i * 30)) === code.toString()) {
                return true;
            }
        }
        return false;
    },

    getCode(secret, time) {
        const timeSlice = Buffer.alloc(8);
        const slice = BigInt(Math.floor(time / 30));
        timeSlice.writeBigUInt64BE(slice);

        const key = this.base32Decode(secret);
        const hmac = crypto.createHmac('sha1', key).update(timeSlice).digest();

        const offset = hmac[hmac.length - 1] & 0xf;
        const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
        return code.toString().padStart(6, '0');
    },

    base32Decode(base32) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        let output = Buffer.alloc(Math.ceil(base32.length * 5 / 8));
        let index = 0;

        const cleanBase32 = base32.toUpperCase().replace(/=+$/, '');
        for (let i = 0; i < cleanBase32.length; i++) {
            const val = alphabet.indexOf(cleanBase32[i]);
            if (val === -1) throw new Error('Invalid base32 character');
            bits += val.toString(2).padStart(5, '0');
            while (bits.length >= 8) {
                output[index++] = parseInt(bits.substring(0, 8), 2);
                bits = bits.substring(8);
            }
        }
        return output.subarray(0, index);
    }
};

// --- Routes ---
router.get('/', (req, res) => {
    res.redirect('/setup/dashboard');
});

router.get('/login', (req, res) => {
    const error = req.query.error;
    res.send(`
        <html>
        <head>
            <title>Setup Login</title>
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
            <style>
                body { background: #121212; color: #e0e0e0; height: 100vh; display: flex; align-items: center; justify-content: center; font-family: sans-serif; }
                .card { background: #1e1e1e; border: 1px solid #333; width: 400px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
                .form-control { background: #2c2c2c; border: 1px solid #444; color: #fff; }
                .form-control:focus { background: #333; border-color: #0d6efd; color: #fff; box-shadow: none; }
                .form-label { color: #bbb; font-weight: 500; }
                .text-primary { color: #0d6efd !important; }
            </style>
        </head>
        <body>
            <div class="card p-4">
                <h3 class="text-center mb-4 text-primary">TaNoClo Setup</h3>
                ${error ? `<div class="alert alert-danger py-2 small mb-3">${error}</div>` : ''}
                <form action="/setup/login" method="POST" id="setup-login-form">
                    <div class="mb-3">
                        <label for="setup_user" class="form-label small">Username</label>
                        <input type="text" id="setup_user" name="username" class="form-control" autocomplete="username" required>
                    </div>
                    <div class="mb-3">
                        <label for="setup_pass" class="form-label small">Password</label>
                        <input type="password" id="setup_pass" name="password" class="form-control" autocomplete="current-password" required>
                    </div>
                    <div class="mb-4">
                        <label for="setup_totp" class="form-label small">2FA Code (TOTP)</label>
                        <input type="text" id="setup_totp" name="totp" class="form-control" placeholder="6-digit code" autocomplete="one-time-code">
                    </div>
                    <button type="submit" class="btn btn-primary w-100">Login</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

router.post('/login', async (req, res) => {
    const { username, password, totp } = req.body;
    const pool = db.getPool();
    try {
        const [rows] = await pool.execute('SELECT * FROM admin_users WHERE username = ?', [username]);
        if (rows.length === 0) return res.redirect('/setup/login?error=Invalid+credentials');

        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.redirect('/setup/login?error=Invalid+credentials');

        if (user.totp_secret) {
            if (!totp || !TOTP.verify(user.totp_secret, totp)) {
                return res.redirect('/setup/login?error=Invalid+2FA+code');
            }
        }

        const token = jwt.sign({ id: user.id, username: user.username }, config.jwtSecret, { expiresIn: '24h' });
        res.cookie('setup_token', token, { httpOnly: true, secure: true, sameSite: 'lax' });
        res.redirect('/setup/dashboard');
    } catch (err) {
        _log('error', `Setup login error: ${err.message}`);
        res.redirect('/setup/login?error=Internal+Server+Error');
    }
});

router.get('/logout', (req, res) => {
    res.clearCookie('setup_token');
    res.redirect('/setup/login');
});

module.exports = router;
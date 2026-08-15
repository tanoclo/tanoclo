/**
 * @file migrations/0004_hash_tokens.js
 * @brief Hash existing access and refresh tokens in the database.
 */

'use strict';

const crypto = require('crypto');

function hashToken(token) {
    if (!token) return token;
    return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
    async up(connection) {
        // 1. Hash access tokens
        const [accessTokens] = await connection.execute('SELECT access_token FROM oauth_access_tokens');
        let accessCount = 0;
        for (const row of accessTokens) {
            const rawToken = row.access_token;
            if (/^[a-f0-9]{64}$/.test(rawToken)) continue;
            const hashed = hashToken(rawToken);
            // Since access_token is a TEXT type, we can do a standard WHERE lookup or restrict by user_id too if needed.
            // But standard comparison on TEXT works for equality.
            await connection.execute('UPDATE oauth_access_tokens SET access_token = ? WHERE access_token = ?', [hashed, rawToken]);
            accessCount++;
        }
        console.log(`[MIGRATION] Hashed ${accessCount} access tokens`);

        // 2. Hash refresh tokens
        const [refreshTokens] = await connection.execute('SELECT refresh_token FROM oauth_refresh_tokens');
        let refreshCount = 0;
        for (const row of refreshTokens) {
            const rawToken = row.refresh_token;
            if (/^[a-f0-9]{64}$/.test(rawToken)) continue;
            const hashed = hashToken(rawToken);
            await connection.execute('UPDATE oauth_refresh_tokens SET refresh_token = ? WHERE refresh_token = ?', [hashed, rawToken]);
            refreshCount++;
        }
        console.log(`[MIGRATION] Hashed ${refreshCount} refresh tokens`);
    }
};

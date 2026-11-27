/**
 * @file migrations/0035_drop_virtual_leader_and_mode_guards.js
 * @brief Drops the IB virtual leader flag and the flow-optimizer on/off guard settings.
 *
 * The IB firmware has no zone leader logic, so IB-hosted virtual leaders cannot work.
 * The flow optimizer no longer switches the circuit between standby and heat (the RU bus
 * module keeps CH enabled while circuit demand > 0), so the guards that only acted on
 * that switch are removed. Circuits left in server "standby" are restored to mode 1.
 */

'use strict';

const DROPPED = {
    devices: ['is_virtual_leader'],
    flow_temperature_settings: [
        'guard_lockout_enabled', 'guard_lockout_duration_min', 'guard_lockout_override_deficit',
        'guard_delta_t_enabled', 'guard_delta_t_min_temp',
        'guard_min_runtime_enabled', 'guard_min_runtime_seconds',
        'guard_thermal_load_enabled',
        'guard_valve_lead_enabled', 'guard_valve_lead_seconds'
    ]
};

async function columnExists(pool, table, column) {
    const [rows] = await pool.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows.length > 0;
}

async function up(pool) {
    console.log('[Migration 0035] Dropping virtual leader flag and flow-optimizer mode guards...');

    // Zones led by a removed IB virtual leader fall back to their first physical device.
    if (await columnExists(pool, 'devices', 'is_virtual_leader')) {
        await pool.execute(`
            UPDATE zones z
            SET z.measuring_device_serial = (
                SELECT d.serial_no FROM devices d
                WHERE d.zone_id = z.id AND d.home_id = z.home_id
                  AND d.is_virtual_leader = 0 AND d.serial_no NOT LIKE 'IB\_VS\_%'
                ORDER BY (d.device_type LIKE 'RU%') DESC, d.serial_no LIMIT 1
            )
            WHERE z.measuring_device_serial LIKE 'IB\_VS\_%'
               OR z.measuring_device_serial IN (SELECT serial_no FROM devices WHERE is_virtual_leader = 1)
        `);
        await pool.execute("DELETE FROM devices WHERE is_virtual_leader = 1 OR serial_no LIKE 'IB\_VS\_%'");
    }

    for (const [table, columns] of Object.entries(DROPPED)) {
        for (const column of columns) {
            if (await columnExists(pool, table, column)) {
                await pool.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
                console.log(`[Migration 0035] Dropped ${table}.${column}`);
            }
        }
    }

    await pool.execute('UPDATE heating_circuits SET field_2090 = 1 WHERE field_2090 = 0');

    console.log('[Migration 0035] Migration complete.');
}

async function down() {
    // Irreversible: the dropped features no longer exist in code.
}

module.exports = { up, down };

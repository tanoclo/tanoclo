-- Synthetic baseline test fixtures for CI environments (safe, non-private data)
SET FOREIGN_KEY_CHECKS = 0;

-- Server settings defaults
INSERT INTO `server_settings` (`key`, `value`) VALUES
  ('cleanup_device_measurements_days', '30'),
  ('cleanup_zone_measurements_days', '390'),
  ('cleanup_home_weather_days', '390'),
  ('log_level', 'debug'),
  ('carto_api_key', 'ci_test_carto_key')
ON DUPLICATE KEY UPDATE `value`=VALUES(`value`);

-- Synthetic baseline test home
INSERT INTO `homes` (
  `id`, `name`, `temperature_unit`, `installation_completed`, `simple_smart_schedule_enabled`, 
  `away_radius_in_meters`, `installation_method`, `incident_detection_enabled`, `latitude`, `longitude`, 
  `presence`, `presence_locked`, `is_proxied`, `allow_commands_in_proxy`, `ha_discovery_enabled`, `insulation_factor`
) VALUES (
  999999, 'Test Home', 'CELSIUS', 1, 1, 
  400.00, 'MANUAL', 0, 50.8503, 4.3517, 
  'HOME', 0, 0, 1, 1, 0.70
)
ON DUPLICATE KEY UPDATE `name`='Test Home';

-- Synthetic test heating zone
INSERT INTO `zones` (
  `id`, `home_id`, `name`, `type`, `open_window_enabled`, `open_window_timeout`, 
  `dazzle_enabled`, `early_start_enabled`, `min_temp`, `max_temp`, `step_temp`, 
  `default_overlay_type`, `config_etag`
) VALUES (
  1, 999999, 'Living Room', 'HEATING', 0, 900, 
  0, 0, 5.0, 25.0, 0.5, 
  'MANUAL', UNHEX('7a6f6e65636f6e666967657461673132')
)
ON DUPLICATE KEY UPDATE `name`='Living Room';

-- Synthetic test devices (IB, VA, RU)
INSERT INTO `devices` (
  `serial_no`, `device_type`, `home_id`, `zone_id`, `current_fw_version`, 
  `connection_state`, `in_pairing_mode`, `connection_state_timestamp`, 
  `config_etag`, `config_etag_real`, `lock_etag`, `lock_etag_real`, `sen_etag`, `act_etag`
) VALUES 
  ('IB0000000001', 'IB01', 999999, NULL, '92.1', 1, 0, '2026-07-01T00:00:00Z', UNHEX('636f6e66696765746167313233343536'), UNHEX('636f6e66696765746167313233343536'), UNHEX('6c6f636b657461673132333435363738'), UNHEX('6c6f636b657461673132333435363738'), UNHEX('73656e65746167313233343536373839'), UNHEX('61637465746167313233343536373839')),
  ('VA0000000001', 'VA01', 999999, 1, '81.1', 1, 0, '2026-07-01T00:00:00Z', UNHEX('636f6e66696765746167313233343536'), UNHEX('636f6e66696765746167313233343536'), UNHEX('6c6f636b657461673132333435363738'), UNHEX('6c6f636b657461673132333435363738'), UNHEX('73656e65746167313233343536373839'), UNHEX('61637465746167313233343536373839')),
  ('RU0000000001', 'RU01', 999999, 1, '85.1', 1, 0, '2026-07-01T00:00:00Z', UNHEX('636f6e66696765746167313233343536'), UNHEX('636f6e66696765746167313233343536'), UNHEX('6c6f636b657461673132333435363738'), UNHEX('6c6f636b657461673132333435363738'), UNHEX('73656e65746167313233343536373839'), UNHEX('61637465746167313233343536373839'))
ON DUPLICATE KEY UPDATE `current_fw_version`=VALUES(`current_fw_version`);

-- Synthetic test heating circuit
INSERT INTO `heating_circuits` (
  `home_id`, `number`, `driver_serial_no`, `config_etag`, `config_etag_real`
) VALUES (
  999999, 1, 'IB0000000001', UNHEX('63697263756974657461673132333435'), UNHEX('63697263756974657461673132333435')
)
ON DUPLICATE KEY UPDATE `driver_serial_no`=VALUES(`driver_serial_no`);

-- Synthetic test admin user
INSERT INTO `users` (`id`, `name`, `email`, `username`, `password`, `locale`, `home_id`)
VALUES ('test-admin-uuid', 'Test Admin', 'admin@example.com', 'admin', '$2b$10$BPZFTo9gTOSNLKGxlf6jDuZnZeVMXF7FveuO7afFQaOqy9GYdnD/.', 'en', 999999)
ON DUPLICATE KEY UPDATE `username`='admin';

-- Whitelist synthetic device and home
INSERT INTO `websocket_whitelist` (`type`, `value`) VALUES
  ('device', 'IB0000000001'),
  ('home', '999999')
ON DUPLICATE KEY UPDATE `value`=VALUES(`value`);

SET FOREIGN_KEY_CHECKS = 1;

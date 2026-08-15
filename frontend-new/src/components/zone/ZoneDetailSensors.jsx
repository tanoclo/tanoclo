/**
 * @file src/components/zone/ZoneDetailSensors.jsx
 * @brief Renders the current sensor telemetry (inside temperature, humidity, active leaders) within ZoneDetail.
 */



/**
 * @brief Zone detail overlay sensors row sub-panel.
 * @param {boolean} props.isDhw - Whether target zone is Domestic Hot Water.
 * @param {object} props.sensorData - Inside temperature and humidity measurements payload.
 * @param {string} props.leaderName - Name description of the zone leader hardware.
 * @param {function} props.t - Translation resolver hook.
 */
export default function ZoneDetailSensors({ isDhw, sensorData, leaderName: _leaderName, t }) {
  if (!isDhw) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        marginBottom: '0.75rem',
        width: '100%'
      }}>
        <div style={{
          fontSize: '0.75rem',
          fontWeight: 700,
          letterSpacing: '0.8px',
          textTransform: 'uppercase',
          color: 'rgba(255, 255, 255, 0.9)',
          display: 'flex',
          gap: '8px'
        }}>
          <span>{t('zone_detail.inside')} {sensorData?.insideTemperature?.celsius?.toFixed(1) || '--'}°</span>
          <span style={{ opacity: 0.5 }}>|</span>
          <span>{t('zone_detail.humidity')} {sensorData?.humidity?.percentage || '--'}%</span>
        </div>
      </div>
    );
  } else {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        marginBottom: '0.75rem',
        width: '100%'
      }}>
        <div style={{
          fontSize: '0.75rem',
          fontWeight: 700,
          letterSpacing: '0.8px',
          textTransform: 'uppercase',
          color: 'rgba(255, 255, 255, 0.9)',
          display: 'flex',
          gap: '8px'
        }}>
        </div>
      </div>
    );
  }
}

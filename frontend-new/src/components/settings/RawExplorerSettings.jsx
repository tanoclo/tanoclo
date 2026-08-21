/**
 * @file src/components/settings/RawExplorerSettings.jsx
 * @brief Renders the low-level raw measurement TLV field explorer tool.
 * 
 * Interacts with TaNoClo-specific backend diagnostic APIs to query exact
 * database states for zone/device raw TLV field IDs (FIDs), mapping friendly labels
 * to undocumented hex keys (like field_6200 for Schedule Target Temperature).
 */

import { useState } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import Button from '../common/Button';
import Spinner from '../common/Spinner';
import { useHome } from '../../context/HomeContext';
import { getRawZoneData, getRawDeviceData } from '../../api/tanoclo';
import { getDevices } from '../../api/devices';
import { SWR_KEYS } from '../../utils/swrKeys';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import logger from '../../utils/logger';

const FRIENDLY_LABELS = {
  // Zone Measurements FIDs
  field_6200: 'Schedule Target Temp',
  field_6280: 'Overlay Target Temp',
  field_6240: 'Overlay Mode',
  field_6160: 'Presence Mode (1=Home, 2=Away)',
  field_40a0: 'Heating Demand %',
  field_61e0: 'Zone Enabled',
  field_6180: 'Zone State Flag',
  field_62e0: 'Overlay Aux Flag',
  field_6440: 'Resume Schedule Trigger',
  open_window_detected: 'Open Window Detected',
  field_012d: 'Ambient Temperature',
  field_0135: 'Humidity',
  // Device Measurements FIDs
  field_012e: 'Aux Temperature 1',
  field_01c8: 'Aux Temperature 2',
  field_0137: 'Dial Encoder Steps',
  field_027a: 'Dial Interaction Result',
  field_0160: 'Reset Reason',
  field_0161: 'HVAC Link Status Flags',
  field_0162: 'Battery Voltage (mV)',
  field_0136: 'Encoder Raw Pulses',
  link_state: 'Link State',
  tado_mode: 'Auto Mode',
  field_6020: 'Zone Service Type'
};

const parseTimestampToDate = (ts) => {
  if (!ts) return new Date();
  if (typeof ts === 'string') {
    if (!ts.includes('T') && !ts.includes('Z') && !ts.includes('+')) {
      return new Date(ts.replace(' ', 'T') + 'Z');
    }
  }
  return new Date(ts);
};

/**
 * @brief Raw measurement TLV field explorer panel.
 */
export default function RawExplorerSettings() {
  const { t } = useTranslation();
  const { activeHomeId, zones, homeInfo } = useHome();
  const { data: allDevices } = useSWR(activeHomeId ? SWR_KEYS.devices(activeHomeId) : null, () => getDevices(activeHomeId));
  
  const homeTimeZone = homeInfo?.dateTimeZone || 'UTC';
  
  const getFriendlyLabel = (key) => {
    let lookupKey = key;
    if (!key.startsWith('field_') && key !== 'open_window_detected') {
      lookupKey = `field_${key}`;
    }
    const translated = t(`tanoclo_ex.friendly_labels.${lookupKey}`);
    if (translated && translated !== `tanoclo_ex.friendly_labels.${lookupKey}`) {
      return translated;
    }
    return FRIENDLY_LABELS[key] || key;
  };
  
  const [explorerType, setExplorerType] = useState('zone');
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [selectedDeviceSerial, setSelectedDeviceSerial] = useState('');
  const [explorerData, setExplorerData] = useState(null);
  const [isFetchingExplorer, setIsFetchingExplorer] = useState(false);

  const handleFetchExplorer = async () => {
    setIsFetchingExplorer(true);
    setExplorerData(null);
    try {
      if (explorerType === 'zone' && selectedZoneId) {
        const res = await getRawZoneData(activeHomeId, selectedZoneId);
        setExplorerData(res);
      } else if (explorerType === 'device' && selectedDeviceSerial) {
        const res = await getRawDeviceData(activeHomeId, selectedDeviceSerial);
        setExplorerData(res);
      }
    } catch (e) {
      logger.error('Failed to fetch telemetry explorer data:', e);
    } finally {
      setIsFetchingExplorer(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      
      {/* Title */}
      <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.raw_explorer_title')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
          {t('tanoclo_ex.query_desc')}
        </p>
      </div>

      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.source_type')}</label>
            <select 
              value={explorerType}
              onChange={(e) => {
                setExplorerType(e.target.value);
                setExplorerData(null);
              }}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.4rem 0.6rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <option value="zone">{t('settings.zone_measurements')}</option>
              <option value="device">{t('settings.device_measurements')}</option>
            </select>
          </div>

          {explorerType === 'zone' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.select_room_zone')}</label>
              <select 
                value={selectedZoneId}
                onChange={(e) => setSelectedZoneId(e.target.value)}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.4rem 0.6rem',
                  borderRadius: 'var(--radius-sm)',
                  outline: 'none',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <option value="">{t('tanoclo_ex.choose_room')}</option>
                {zones?.map(z => (
                  <option key={z.id} value={z.id}>{z.name} (ID: {z.id})</option>
                ))}
              </select>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.select_smart_thermostat')}</label>
              <select 
                value={selectedDeviceSerial}
                onChange={(e) => setSelectedDeviceSerial(e.target.value)}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.4rem 0.6rem',
                  borderRadius: 'var(--radius-sm)',
                  outline: 'none',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <option value="">{t('tanoclo_ex.choose_device')}</option>
                {allDevices && allDevices.length > 0 ? (
                  allDevices.map(d => (
                    <option key={d.serialNo} value={d.serialNo}>
                      {d.friendlyName ? `${d.friendlyName} (${d.serialNo})` : `${d.serialNo} (${d.deviceType})`}
                    </option>
                  ))
                ) : (
                  (() => {
                    const seen = new Set();
                    const uniqueDevices = [];
                    zones?.flatMap(z => z.devices || []).forEach(d => {
                      if (d && d.serialNo && !seen.has(d.serialNo)) {
                        seen.add(d.serialNo);
                        uniqueDevices.push(d);
                      }
                    });
                    return uniqueDevices.map(d => (
                      <option key={d.serialNo} value={d.serialNo}>{d.serialNo} ({d.deviceType})</option>
                    ));
                  })()
                )}
              </select>
            </div>
          )}

          <Button 
            onClick={handleFetchExplorer} 
            disabled={isFetchingExplorer || (explorerType === 'zone' ? !selectedZoneId : !selectedDeviceSerial)}
            variant="primary"
            style={{ padding: '0.45rem 1rem' }}
          >
            <RefreshCw size={14} className={isFetchingExplorer ? 'pulse-icon' : ''} style={{ marginRight: '0.25rem' }} />
            <span>{t('settings.fetch_db_logs')}</span>
          </Button>
        </div>
      </Card>

      {isFetchingExplorer && <div style={{ textAlign: 'center', padding: '2rem' }}><Spinner size={24} /></div>}

      {explorerData && explorerData.measurements && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h4 style={{ fontSize: '0.9rem', fontWeight: 700, margin: 0 }}>
            {t('tanoclo_ex.showing_records', { count: explorerData.measurements.length, target: explorerType === 'zone' ? `Zone #${selectedZoneId}` : `Device ${selectedDeviceSerial}` })}
          </h4>

          {explorerData.measurements.length === 0 ? (
            <Card style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
              {t('tanoclo_ex.no_raw_measurements')}
            </Card>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.8rem' }}>
                <thead>
                  <tr style={{ backgroundColor: 'var(--bg-input)', borderBottom: '1px solid var(--border-color)' }}>
                    <th style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{t('settings.timestamp')}</th>
                    {Object.keys(explorerData.measurements[0])
                      .filter(k => !['id', 'home_id', 'zone_id', 'device_serial', 'timestamp'].includes(k))
                      .map(key => {
                        const label = getFriendlyLabel(key);
                        return (
                          <th 
                            key={key} 
                            style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}
                            title={label}
                          >
                            {label !== key ? `${label} (${key})` : key}
                          </th>
                        );
                      })}
                  </tr>
                </thead>
                <tbody>
                  {explorerData.measurements.map(row => (
                    <tr key={row.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                        {parseTimestampToDate(row.timestamp).toLocaleTimeString([], { timeZone: homeTimeZone })}<br/>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{parseTimestampToDate(row.timestamp).toLocaleDateString([], { timeZone: homeTimeZone })}</span>
                      </td>
                      {Object.entries(row)
                        .filter(([k]) => !['id', 'home_id', 'zone_id', 'device_serial', 'timestamp'].includes(k))
                        .map(([k, val]) => (
                          <td key={k} style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace', fontWeight: 600 }}>
                            {val !== null ? String(val) : '--'}
                          </td>
                        ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

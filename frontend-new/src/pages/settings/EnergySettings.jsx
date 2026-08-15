/**
 * @file src/pages/settings/EnergySettings.jsx
 * @brief Energy Settings panel rendering boiler operating times and zone telemetry profiles.
 * 
 * Provides interactive date controls to fetch boiler activity aggregated by day or month,
 * lazy-loads HeatingActivityChart, and displays raw zone telemetry profiles using CombinedTelemetryChart.
 */

import { useState, useEffect, lazy, Suspense } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'react-i18next';
import Card from '../../components/common/Card';
import Button from '../../components/common/Button';
import Spinner from '../../components/common/Spinner';
const HeatingActivityChart = lazy(() => import('../../components/charts/HeatingActivityChart'));
const CombinedTelemetryChart = lazy(() => import('../../components/charts/CombinedTelemetryChart'));
import { getRunningTimes } from '../../api/heating';
import { apiFetch } from '../../api/client';
import { SWR_KEYS } from '../../utils/swrKeys';

/**
 * @brief Renders the Energy/Boiler Settings page component.
 * @param {string} props.homeId - Target home identifier.
 * @param {Array} props.zones - List of configured zones.
 */
export default function EnergySettings({ homeId, zones }) {
  const { t } = useTranslation();

  // Raw Boiler & Zone Telemetry selector states
  const [selectedTelemetryZoneId, setSelectedTelemetryZoneId] = useState(null);
  const [telemetryDate, setTelemetryDate] = useState(new Date().toLocaleDateString('sv'));

  // Heating Activity / Boiler Page inline states
  const [boilerAggregate, setBoilerAggregate] = useState('month');

  const getPastDateStr = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toLocaleDateString('sv'); // YYYY-MM-DD
  };
  const getTodayStr = () => new Date().toLocaleDateString('sv');

  const [boilerFromDate, setBoilerFromDate] = useState(getPastDateStr(30));
  const [boilerToDate, setBoilerToDate] = useState(getTodayStr());

  useEffect(() => {
    const targetFrom = boilerAggregate === 'month' ? getPastDateStr(365) : getPastDateStr(30);
    setBoilerFromDate(prev => prev !== targetFrom ? targetFrom : prev);
    const targetTo = getTodayStr();
    setBoilerToDate(prev => prev !== targetTo ? targetTo : prev);
  }, [boilerAggregate]);

  const { data: runningTimesData } = useSWR(
    homeId && boilerFromDate && boilerToDate
      ? SWR_KEYS.runningTimesQuery(homeId, boilerFromDate, boilerToDate, boilerAggregate)
      : null,
    () => getRunningTimes(homeId, { from: boilerFromDate, to: boilerToDate, aggregate: boilerAggregate })
  );

  const { data: telemetryData, error: telemetryError, isLoading: isTelemetryLoading } = useSWR(
    homeId && selectedTelemetryZoneId && telemetryDate
      ? SWR_KEYS.dayReport(homeId, selectedTelemetryZoneId, telemetryDate)
      : null,
    () => apiFetch(`/api/v2/homes/${homeId}/tanoclo/zones/${selectedTelemetryZoneId}/dayReport?date=${telemetryDate}`)
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('heating_activity.title')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
          {t('settings.heating_activity_desc')}
        </p>
      </div>

      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '1rem',
        marginTop: '0.5rem'
      }}>
        <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>
          {t('settings.heating_operating_times')}
        </h3>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          {/* Date Inputs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input
              type="date"
              value={boilerFromDate}
              onChange={(e) => setBoilerFromDate(e.target.value)}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.35rem 0.5rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            />
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>to</span>
            <input
              type="date"
              value={boilerToDate}
              onChange={(e) => setBoilerToDate(e.target.value)}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.35rem 0.5rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            />
          </div>

          {/* Daily / Monthly Toggles */}
          <div style={{
            display: 'flex',
            backgroundColor: 'var(--bg-input)',
            padding: '2px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-color)',
          }}>
            <button
              onClick={() => setBoilerAggregate('day')}
              style={{
                padding: '0.35rem 0.85rem',
                borderRadius: 'calc(var(--radius-md) - 4px)',
                border: 'none',
                backgroundColor: boilerAggregate === 'day' ? 'var(--bg-card-hover)' : 'transparent',
                color: boilerAggregate === 'day' ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: 600,
                fontSize: '0.8rem',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)'
              }}
            >
              {t('settings.daily')}
            </button>
            <button
              onClick={() => setBoilerAggregate('month')}
              style={{
                padding: '0.35rem 0.85rem',
                borderRadius: 'calc(var(--radius-md) - 4px)',
                border: 'none',
                backgroundColor: boilerAggregate === 'month' ? 'var(--bg-card-hover)' : 'transparent',
                color: boilerAggregate === 'month' ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: 600,
                fontSize: '0.8rem',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)'
              }}
            >
              {t('settings.monthly')}
            </button>
          </div>
        </div>
      </div>

      <Card style={{ padding: '1rem' }}>
        {runningTimesData ? (
          <Suspense fallback={
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
              <Spinner size={24} />
            </div>
          }>
            <HeatingActivityChart runningTimesData={runningTimesData} zones={zones} aggregate={boilerAggregate} />
          </Suspense>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
            <Spinner size={24} />
          </div>
        )}
      </Card>

      {/* Zone Telemetry Profile */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700 }}>
            {t('zone.system_telemetry_profiles')}
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', margin: '4px 0 0' }}>
            {t('settings.telemetry_profile_desc', 'Select a zone to inspect detailed historical temperature, target settings, and heating power telemetry profiles.')}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={selectedTelemetryZoneId || ''}
            onChange={(e) => setSelectedTelemetryZoneId(e.target.value ? parseInt(e.target.value) : null)}
            style={{
              backgroundColor: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
              padding: '0.4rem 0.6rem',
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
              minWidth: '180px'
            }}
          >
            <option value="">{t('tanoclo_ex.choose_room', '-- Select Room --')}</option>
            {(zones || []).filter(z => z.type === 'HEATING').map(z => (
              <option key={z.id} value={z.id}>{z.name}</option>
            ))}
          </select>

          {selectedTelemetryZoneId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Button
                variant="secondary"
                onClick={() => {
                  const d = new Date(telemetryDate);
                  d.setDate(d.getDate() - 1);
                  setTelemetryDate(d.toLocaleDateString('sv'));
                }}
                style={{ padding: '0.35rem 0.65rem', minWidth: 'auto', fontSize: '0.85rem' }}
              >
                &lt;
              </Button>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, fontFamily: 'monospace' }}>
                {telemetryDate}
              </span>
              <Button
                variant="secondary"
                onClick={() => {
                  const d = new Date(telemetryDate);
                  d.setDate(d.getDate() + 1);
                  setTelemetryDate(d.toLocaleDateString('sv'));
                }}
                style={{ padding: '0.35rem 0.65rem', minWidth: 'auto', fontSize: '0.85rem' }}
              >
                &gt;
              </Button>
            </div>
          )}
        </div>

        {selectedTelemetryZoneId && (
          <div style={{ marginTop: '0.5rem' }}>
            {isTelemetryLoading && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                <Spinner size={24} />
              </div>
            )}
            {telemetryError && (
              <div style={{ color: 'var(--danger)', fontSize: '0.85rem', padding: '1rem', textAlign: 'center' }}>
                {t('zone.failed_load_telemetry')}
              </div>
            )}
            {telemetryData && !isTelemetryLoading && (
              <div style={{ minHeight: '300px' }}>
                <Suspense fallback={
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                    <Spinner size={24} />
                  </div>
                }>
                  <CombinedTelemetryChart dayReportData={telemetryData} />
                </Suspense>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

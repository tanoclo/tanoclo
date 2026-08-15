/**
 * @file src/pages/ClimateQualityPage.jsx
 * @brief Climate and Air Quality index diagnostics display page.
 * 
 * Displays calculated indoor air comfort levels for individual home zones using SWR to fetch
 * weather telemetry and comfort benchmarks (freshness, humidity levels). Groups and passes
 * state attributes to layout cards like ClimateQualityHero and ZoneClimateCard.
 */


import { useNavigate } from 'react-router';
import useSWR from 'swr';
import AppShell from '../components/layout/AppShell';
import ClimateQualityHero from '../components/climatequality/ClimateQualityHero';
import ZoneClimateCard from '../components/climatequality/ZoneClimateCard';
import Spinner from '../components/common/Spinner';
import Card from '../components/common/Card';
import { useHome } from '../context/HomeContext';
import { getClimateQuality } from '../api/weather';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import { SWR_KEYS } from '../utils/swrKeys';

/**
 * @brief Renders the comfort metrics overview dashboard.
 */
export default function ClimateQualityPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeHomeId, zones, zoneStates, weather, isLoading: isHomeLoading } = useHome();

  // Fetch climate quality diagnostics (freshness ratings and room-by-room comfort arrays)
  const {
    data: climateQuality,
    error: climateQualityError,
    isLoading: isClimateQualityLoading
  } = useSWR(
    activeHomeId ? SWR_KEYS.climateQuality(activeHomeId) : null,
    () => getClimateQuality(activeHomeId),
    { revalidateOnFocus: false }
  );

  const isLoading = isHomeLoading || isClimateQualityLoading;

  return (
    <AppShell title={t('air_comfort.title')} showBack={true} onBack={() => navigate('/')}>
      <div className="page-container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        
        {/* Title */}
        <div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
            {t('air_comfort.subtitle')}
          </p>
        </div>

        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
            <Spinner size={32} />
          </div>
        ) : climateQualityError ? (
          <Card style={{ padding: '2rem', textAlign: 'center', color: 'var(--danger)' }}>
            <ShieldAlert size={32} style={{ margin: '0 auto 0.75rem' }} />
            <p>{t('air_comfort.failed_load')}</p>
          </Card>
        ) : (
          <>
            {/* Air Freshness Overview Card */}
            <ClimateQualityHero freshness={climateQuality?.freshness} weather={weather} />

            {/* Comfort Cards Grid */}
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '1rem', marginBottom: '0.25rem' }}>
              {t('air_comfort.zones_comfort')}
            </h2>

            {zones && zones.length > 0 ? (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: '1.5rem'
              }}>
                {zones
                  .filter(z => z.type !== 'HOT_WATER' && z.type !== 'DHW')
                  .map((zone) => {
                    const comfortItem = climateQuality?.comfort?.find(c => c.roomId === zone.id);
                    return (
                      <ZoneClimateCard 
                        key={zone.id}
                        name={zone.name}
                        comfort={comfortItem}
                        state={zoneStates?.zoneStates?.[zone.id]}
                        outsideTemp={weather?.outsideTemperature?.celsius}
                      />
                    );
                  })}
              </div>
            ) : (
              <Card style={{ padding: '2rem', textAlign: 'center' }}>
                <p style={{ color: 'var(--text-secondary)' }}>{t('air_comfort.no_zones')}</p>
              </Card>
            )}
          </>
        )}

      </div>
    </AppShell>
  );
}

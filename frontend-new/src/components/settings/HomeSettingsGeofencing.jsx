/**
 * @file src/components/settings/HomeSettingsGeofencing.jsx
 * @brief Renders the map and radius controls picker for home geofence configuration settings.
 */


import Card from '../common/Card';
import Button from '../common/Button';
import { Navigation, Save } from 'lucide-react';

/**
 * @brief Home settings geofencing control sub-panel.
 * @param {number} props.lat - Geofence home latitude setting.
 * @param {number} props.lon - Geofence home longitude setting.
 * @param {number} props.radius - Active geofence boundary radius in meters.
 * @param {function} props.setRadius - Radius change handler.
 * @param {function} props.handleUseMyLocation - Browser Geolocation query callback.
 * @param {function} props.handleSaveLocation - Geofencing save callback dispatcher.
 * @param {boolean} props.isSavingLocation - Saving location API request progress indicator.
 * @param {object} props.mapRef - Leaflet HTML map element reference container.
 * @param {function} props.t - Translation resolver hook.
 */
export default function HomeSettingsGeofencing({
  lat,
  lon,
  radius,
  setRadius,
  handleUseMyLocation,
  handleSaveLocation,
  isSavingLocation,
  mapRef,
  t
}) {
  return (
    <form onSubmit={handleSaveLocation} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Map Coordinates Picker */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.map_coordinates')}</h3>
          <Button 
            type="button" 
            variant="secondary" 
            onClick={handleUseMyLocation}
            style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
          >
            <Navigation size={12} />
            <span>{t('settings.use_my_location')}</span>
          </Button>
        </div>

        <div 
          ref={mapRef} 
          style={{ 
            height: '240px', 
            width: '100%', 
            borderRadius: 'var(--radius-md)', 
            border: '1px solid var(--border-color)',
            overflow: 'hidden',
            zIndex: 1
          }} 
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          <div>{t('settings.latitude')}: <strong>{lat.toFixed(6)}</strong></div>
          <div>{t('settings.longitude')}: <strong>{lon.toFixed(6)}</strong></div>
        </div>

        {/* Geofence Radius Slider */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem', marginTop: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 600 }}>
            <span style={{ color: 'var(--text-secondary)' }}>{t('geofencing.radius') || 'Geofence Radius'}</span>
            <span style={{ color: 'var(--primary)' }}>{t('geofencing.meters_count', { count: radius }) || `${radius}m`}</span>
          </div>
          <input 
            type="range"
            min="100"
            max="1500"
            step="50"
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            style={{
              width: '100%',
              height: '6px',
              backgroundColor: 'var(--bg-input)',
              borderRadius: '3px',
              outline: 'none',
              cursor: 'pointer',
              WebkitAppearance: 'none'
            }}
          />
          <div style={{ position: 'relative', height: '28px', marginTop: '4px', fontSize: '0.75rem' }}>
            <span style={{ position: 'absolute', left: '0', color: 'var(--text-muted)' }}>
              {t('geofencing.meters_count', { count: 100 }) || '100m'}
            </span>
            <span style={{ 
              position: 'absolute', 
              left: '14.2857%', 
              transform: 'translateX(-50%)', 
              whiteSpace: 'nowrap', 
              color: 'var(--primary)',
              fontWeight: 600,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              top: 0
            }}>
              <span style={{ fontSize: '0.6rem', lineHeight: 1, marginBottom: '2px' }}>▲</span>
              <span>{t('geofencing.recommended_radius') || 'Recommended Radius'}</span>
            </span>
            <span style={{ position: 'absolute', right: '0', color: 'var(--text-muted)' }}>
              {t('geofencing.meters_count', { count: 1500 }) || '1500m'}
            </span>
          </div>
        </div>

        <Button 
          type="submit" 
          variant="primary" 
          disabled={isSavingLocation}
          style={{ alignSelf: 'flex-end', marginTop: '0.5rem' }}
        >
          <Save size={16} />
          <span>{isSavingLocation ? t('settings.saving') : t('common.save')}</span>
        </Button>
      </Card>
    </form>
  );
}

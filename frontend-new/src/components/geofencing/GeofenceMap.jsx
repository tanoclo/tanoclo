/**
 * @file src/components/geofencing/GeofenceMap.jsx
 * @brief Renders interactive leaflet maps plotting geofence boundaries and member locations.
 * 
 * Maps relative distances and angular bearings from check-in logs to estimate latitude/longitude
 * coordinates of members, rendering them on a CartoDB Voyager tile layer.
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * @brief Geofence interactive map component.
 * @param {object} props.homeInfo - Active home details.
 * @param {Array} props.devices - Paired mobile devices containing location values.
 * @param {number} props.radius - Active geofence boundary radius in meters.
 * @param {function} props.onRadiusChange - Boundary adjustment event callback handler.
 */
export default function GeofenceMap({ homeInfo, devices = [], radius, onRadiusChange }) {
  const { t } = useTranslation();
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const circleInstance = useRef(null);
  const deviceMarkersRef = useRef([]);

  const homeLat = homeInfo?.geolocation?.latitude;
  const homeLon = homeInfo?.geolocation?.longitude;

  // Initialize Map
  useEffect(() => {
    if (!homeLat || !homeLon || !mapRef.current) return;

    // Check if map already exists
    if (!mapInstance.current) {
      // Create map
      mapInstance.current = L.map(mapRef.current, {
        zoomControl: false,
        attributionControl: false
      }).setView([homeLat, homeLon], 15);

      // Add OpenStreetMap tiles (bright-themed look using CartoDB Voyager tiles)
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
        crossOrigin: true
      }).addTo(mapInstance.current);

      // Add simple zoom control at bottom right
      L.control.zoom({ position: 'bottomright' }).addTo(mapInstance.current);

      // Add Home Marker (custom circular glowing badge)
      const homeIcon = L.divIcon({
        html: `<div style="
          background-color: var(--primary); 
          border: 2px solid #fff; 
          width: 14px; 
          height: 14px; 
          border-radius: 50%; 
          box-shadow: 0 0 10px var(--primary);
        "></div>`,
        className: 'custom-home-marker',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });

      L.marker([homeLat, homeLon], { icon: homeIcon })
        .addTo(mapInstance.current)
        .bindTooltip('Your Home', { permanent: false, direction: 'top' });

      // Add Geofence Circle
      circleInstance.current = L.circle([homeLat, homeLon], {
        color: 'var(--primary)',
        fillColor: 'var(--primary)',
        fillOpacity: 0.1,
        weight: 1.5,
        dashArray: '4, 4',
        radius: radius
      }).addTo(mapInstance.current);

      // Multi-stage invalidateSize calls to ensure map tiles fill container perfectly
      const triggerResize = () => {
        if (mapInstance.current) {
          mapInstance.current.invalidateSize();
        }
      };
      [50, 150, 300, 600].forEach(delay => setTimeout(triggerResize, delay));

      // Attach ResizeObserver to container
      if (window.ResizeObserver && mapRef.current) {
        const ro = new ResizeObserver(() => triggerResize());
        ro.observe(mapRef.current);
      }
    }

    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
        circleInstance.current = null;
      }
    };
  }, [homeLat, homeLon, radius]);

  // Update geofence circle radius when prop changes
  useEffect(() => {
    if (circleInstance.current) {
      circleInstance.current.setRadius(radius);
    }
  }, [radius]);

  // Update/Draw mobile devices on map (reconstructing approximate lat/lon from distance + bearing)
  useEffect(() => {
    if (!mapInstance.current || !homeLat || !homeLon) return;

    // Clear existing device markers
    deviceMarkersRef.current.forEach(m => m.remove());
    deviceMarkersRef.current = [];

    devices.forEach((device) => {
      const loc = device.location;
      if (!loc || loc.stale || loc.relativeDistanceFromHomeFence === undefined || !loc.bearingFromHome) return;

      const dist = loc.relativeDistanceFromHomeFence + radius; // total distance in meters
      const bearingRad = loc.bearingFromHome.radians;

      // Coordinate offset approximation:
      const latOffset = (dist * Math.cos(bearingRad)) / 111111;
      const lonOffset = (dist * Math.sin(bearingRad)) / (111111 * Math.cos((homeLat * Math.PI) / 180));

      const devLat = homeLat + latOffset;
      const devLon = homeLon + lonOffset;

      const dotColor = loc.atHome ? 'var(--success)' : 'var(--warning)';

      const deviceIcon = L.divIcon({
        html: `<div style="
          background-color: ${dotColor}; 
          border: 1.5px solid #fff; 
          width: 12px; 
          height: 12px; 
          border-radius: 50%; 
          box-shadow: 0 0 8px ${dotColor};
        "></div>`,
        className: 'custom-device-marker',
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      });

      const devMarker = L.marker([devLat, devLon], { icon: deviceIcon })
        .addTo(mapInstance.current)
        .bindTooltip(`${device.name} (${loc.atHome ? 'At Home' : 'Away'})`, { 
          permanent: false, 
          direction: 'top' 
        });

      deviceMarkersRef.current.push(devMarker);
    });
  }, [devices, radius, homeLat, homeLon]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
      {/* Map wrapper */}
      <div 
        ref={mapRef} 
        style={{ 
          height: '320px', 
          width: '100%', 
          borderRadius: 'var(--radius-md)', 
          border: '1px solid var(--border-color)',
          overflow: 'hidden',
          backgroundColor: '#0f1115',
          zIndex: 1
        }} 
      />

      {/* Slider Controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 600 }}>
          <span style={{ color: 'var(--text-secondary)' }}>{t('geofencing.radius')}</span>
          <span style={{ color: 'var(--primary)' }}>{t('geofencing.meters_count', { count: radius })}</span>
        </div>
        <input 
          type="range"
          min="100"
          max="1500"
          step="50"
          value={radius}
          onChange={(e) => onRadiusChange(Number(e.target.value))}
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
            {t('geofencing.meters_count', { count: 100 })}
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
            <span>{t('geofencing.recommended_radius')}</span>
          </span>
          <span style={{ position: 'absolute', right: '0', color: 'var(--text-muted)' }}>
            {t('geofencing.meters_count', { count: 1500 })}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * @file src/components/charts/CombinedTelemetryChart.jsx
 * @brief Combined room telemetry chart displaying indoor temperatures, humidity, heating activity, and weather.
 * 
 * Implements ChartJS Line component to display multi-axis data: primary Y-axis for temperature
 * and target settings, secondary Y-axis for humidity percentage, and tertiary/hidden axes for
 * solar intensity and boiler heating request blocks. Renders custom interactive HTML tooltips.
 */

import React, { useState, useContext } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { useTranslation } from 'react-i18next';
import { ThemeContext } from '../../context/ThemeContext';
import { Thermometer, Droplets, Flame, Sun, Cloud, CloudRain, Snowflake, Moon, CloudMoon } from 'lucide-react';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

// Register a custom tooltip positioner that aligns to the mouse/touch position dynamically
Tooltip.positioners.mouseFollow = function(items, eventPosition) {
  if (!eventPosition || eventPosition.x === undefined || eventPosition.y === undefined) {
    return Tooltip.positioners.average(items);
  }

  const chart = this.chart;
  const { width: chartWidth, height: chartHeight } = chart;

  let x = eventPosition.x + 15;
  let y = eventPosition.y + 15;
  let xAlign = 'left';
  let yAlign = 'top';

  // Flip alignment if tooltip would overflow right boundary
  if (eventPosition.x > chartWidth - 200) {
    x = eventPosition.x - 15;
    xAlign = 'right';
  }

  // Flip alignment if tooltip would overflow bottom boundary
  if (eventPosition.y > chartHeight - 160) {
    y = eventPosition.y - 15;
    yAlign = 'bottom';
  }

  return {
    x,
    y,
    xAlign,
    yAlign
  };
};

const getWeatherIcon = (state) => {
  switch (state) {
    case 'CLEAR':
    case 'SUNNY':
    case 'MOSTLY_SUNNY':
      return <Sun size={18} style={{ color: '#ffca28' }} />;
    case 'RAIN':
    case 'RAINY':
    case 'HEAVY_RAIN':
    case 'DRIZZLE':
      return <CloudRain size={18} style={{ color: '#60a5fa' }} />;
    case 'SNOW':
    case 'SNOWY':
      return <Snowflake size={18} style={{ color: '#93c5fd' }} />;
    case 'NIGHT_CLEAR':
      return <Moon size={18} style={{ color: '#e2e8f0' }} />;
    case 'NIGHT_CLOUDY':
      return <CloudMoon size={18} style={{ color: '#94a3b8' }} />;
    default:
      return <Cloud size={18} style={{ color: '#94a3b8' }} />;
  }
};

function CombinedTelemetryChart({ dayReportData }) {
  const { t } = useTranslation();
  const { resolvedTheme: theme } = useContext(ThemeContext);
  const isLight = theme === 'light';

  const isDhw = dayReportData?.zoneType === 'HOT_WATER' || dayReportData?.zoneType === 'DHW';

  const [showTemp, setShowTemp] = useState(true);
  const [showHumidity, setShowHumidity] = useState(!isDhw);
  const [showHeating, setShowHeating] = useState(true);
  const [showSolar, setShowSolar] = useState(false);

  if (!dayReportData) return null;

  const { measuredData, settings, weather, callForHeat, hotWaterProduction } = dayReportData;
  const insideTempPoints = measuredData?.insideTemperature?.dataPoints || [];
  
  if (insideTempPoints.length === 0) {
    return (
      <div style={{
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--text-secondary)'
      }}>
        {t('zone.no_telemetry_data')}
      </div>
    );
  }

  // Format local HH:MM labels from timestamps
  const labels = insideTempPoints.map(pt => {
    const d = new Date(pt.timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  });

  // 1. Inside Temperature
  const insideTemps = insideTempPoints.map(pt => pt.value?.celsius ?? null);
  const hasValidInsideTemps = !isDhw && insideTemps.some(v => v !== null);

  // 2. Target Temperature (aligned with insideTempPoints timestamps)
  const targetTemps = insideTempPoints.map(pt => {
    const ts = new Date(pt.timestamp).getTime();
    const activeSetting = settings?.dataIntervals?.find(interval => {
      const from = new Date(interval.from).getTime();
      const to = new Date(interval.to).getTime();
      return ts >= from && ts <= to;
    });
    return activeSetting?.value?.temperature?.celsius ?? null;
  });

  // 3. Outside Temperature (aligned with insideTempPoints timestamps)
  const outsideTemps = insideTempPoints.map(pt => {
    const ts = new Date(pt.timestamp).getTime();
    const activeWeather = weather?.condition?.dataIntervals?.find(interval => {
      const from = new Date(interval.from).getTime();
      const to = new Date(interval.to).getTime();
      return ts >= from && ts <= to;
    });
    return activeWeather?.value?.temperature?.celsius ?? null;
  });

  // 4. Humidity (aligned to temperature timestamps)
  const humidityValues = insideTempPoints.map(pt => {
    const ts = new Date(pt.timestamp).getTime();
    let closest = null;
    let minDiff = Infinity;
    
    (measuredData?.humidity?.dataPoints || []).forEach(hPt => {
      if (hPt.value === null || hPt.value === undefined) return;
      const diff = Math.abs(new Date(hPt.timestamp).getTime() - ts);
      if (diff < minDiff) {
        minDiff = diff;
        closest = hPt;
      }
    });
    
    return (closest && minDiff <= 600000) ? closest.value * 100 : null;
  });
  const hasValidHumidity = !isDhw && humidityValues.some(v => v !== null);

  // 5. Heating Demand / Hot Water Production (aligned to temperature timestamps)
  const demandValues = insideTempPoints.map(pt => {
    const ts = new Date(pt.timestamp).getTime();
    if (isDhw) {
      const activeHw = hotWaterProduction?.dataIntervals?.find(interval => {
        const from = new Date(interval.from).getTime();
        const to = new Date(interval.to).getTime();
        return ts >= from && ts <= to;
      });
      if (activeHw !== undefined && activeHw.value !== null) {
        return activeHw.value ? 100 : 0;
      }
      const activeSetting = settings?.dataIntervals?.find(interval => {
        const from = new Date(interval.from).getTime();
        const to = new Date(interval.to).getTime();
        return ts >= from && ts <= to;
      });
      return activeSetting?.value?.power === 'ON' ? 100 : 0;
    } else {
      const activeInterval = callForHeat?.dataIntervals?.find(interval => {
        const from = new Date(interval.from).getTime();
        const to = new Date(interval.to).getTime();
        return ts >= from && ts <= to;
      });

      const status = activeInterval?.value || 'NONE';
      switch (status) {
        case 'HIGH': return 100;
        case 'MEDIUM': return 50;
        case 'LOW': return 20;
        default: return 0;
      }
    }
  });

  // 6. Solar Intensity (aligned to temperature timestamps)
  const solarValues = insideTempPoints.map(pt => {
    const ts = new Date(pt.timestamp).getTime();
    let closest = null;
    let minDiff = Infinity;
    
    (measuredData?.solarIntensity?.dataPoints || []).forEach(sPt => {
      if (sPt.value === null || sPt.value === undefined) return;
      const diff = Math.abs(new Date(sPt.timestamp).getTime() - ts);
      if (diff < minDiff) {
        minDiff = diff;
        closest = sPt;
      }
    });
    
    return (closest && minDiff <= 600000) ? closest.value * 100 : null;
  });

  // Build active datasets dynamically
  const datasets = [];

  if (showTemp) {
    if (hasValidInsideTemps) {
      datasets.push({
        label: `${t('zone.inside_temp')} (°C)`,
        data: insideTemps,
        borderColor: '#00d2ff',
        backgroundColor: 'rgba(0, 210, 255, 0.04)',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.3,
        fill: true,
        yAxisID: 'y',
      });
    }
    if (targetTemps.some(v => v !== null)) {
      datasets.push({
        label: `${t('zone.target_temp_short')} (°C)`,
        data: targetTemps,
        borderColor: '#ff8a00',
        borderWidth: 2,
        borderDash: [5, 5],
        pointRadius: 0,
        pointHoverRadius: 4,
        stepped: 'before',
        tension: 0,
        fill: false,
        yAxisID: 'y',
      });
    }
    if (outsideTemps.some(v => v !== null)) {
      datasets.push({
        label: `${t('zone.outside_temp_short')} (°C)`,
        data: outsideTemps,
        borderColor: isLight ? 'rgba(100, 116, 139, 0.5)' : 'rgba(255, 255, 255, 0.35)',
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.3,
        fill: false,
        yAxisID: 'y',
      });
    }
  }

  if (showHumidity && hasValidHumidity) {
    datasets.push({
      label: `${t('common.humidity')} (%)`,
      data: humidityValues,
      borderColor: '#00b4d8',
      backgroundColor: 'rgba(0, 180, 216, 0.03)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      tension: 0.3,
      fill: true,
      yAxisID: 'y1',
    });
  }

  if (showHeating) {
    if (isDhw) {
      datasets.push({
        label: `${t('schedule.hot_water_output')} (%)`,
        data: demandValues,
        borderColor: '#ff7a00',
        backgroundColor: 'rgba(255, 122, 0, 0.12)',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        stepped: 'before',
        tension: 0,
        fill: true,
        yAxisID: 'y1',
      });
    } else {
      datasets.push({
        label: `${t('zone.heating_demand')} (%)`,
        data: demandValues,
        borderColor: '#ff5e62',
        backgroundColor: 'rgba(255, 94, 98, 0.08)',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        stepped: 'before',
        tension: 0,
        fill: true,
        yAxisID: 'y1',
      });
    }
  }

  if (showSolar) {
    datasets.push({
      label: `${t('zone.solar_intensity')} (%)`,
      data: solarValues,
      borderColor: '#ffca28',
      backgroundColor: 'rgba(255, 202, 40, 0.03)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      tension: 0.3,
      fill: true,
      yAxisID: 'y1',
    });
  }

  const data = { labels, datasets };

  // Presence Shading Plugin
  const presencePlugin = {
    id: 'presenceShading',
    beforeDraw: (chart) => {
      const { ctx, chartArea: { top, bottom, left, right } } = chart;
      const presenceIntervals = dayReportData?.presence?.dataIntervals || [];
      
      presenceIntervals.forEach(interval => {
        const fromTime = new Date(interval.from).getTime();
        const toTime = new Date(interval.to).getTime();
        const isHome = interval.value;
        
        const getPixelForTime = (timeMs) => {
          if (insideTempPoints.length === 0) return left;
          const firstMs = new Date(insideTempPoints[0].timestamp).getTime();
          const lastMs = new Date(insideTempPoints[insideTempPoints.length - 1].timestamp).getTime();
          if (timeMs <= firstMs) return left;
          if (timeMs >= lastMs) return right;
          
          const ratio = (timeMs - firstMs) / (lastMs - firstMs);
          return left + ratio * (right - left);
        };
        
        if (!isHome) { // Shade AWAY
          const xStart = getPixelForTime(fromTime);
          const xEnd = getPixelForTime(toTime);
          
          ctx.save();
          ctx.fillStyle = isLight ? 'rgba(100, 116, 139, 0.12)' : 'rgba(75, 85, 99, 0.15)'; // Shading for away
          ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);
          ctx.restore();
        }
      });
    }
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        position: 'mouseFollow',
        mode: 'index',
        intersect: false,
        backgroundColor: 'rgba(20, 24, 33, 0.95)',
        titleColor: '#fff',
        bodyColor: '#e0e0e0',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        borderWidth: 1,
        titleFont: { family: 'Inter, sans-serif' },
        bodyFont: { family: 'Inter, sans-serif' },
        callbacks: {
          label: function(context) {
            let label = context.dataset.label || '';
            if (label) {
              label += ': ';
            }
            if (context.parsed.y !== null) {
              if (context.dataset.yAxisID === 'y') {
                label += context.parsed.y.toFixed(1) + '°C';
              } else {
                if (isDhw && context.dataset.label.includes(t('schedule.hot_water_output'))) {
                  const val = context.parsed.y;
                  label += val > 0 ? t('common.on') : t('common.off');
                } else if (context.dataset.label.includes('Heating') || context.dataset.label.includes(t('dashboard.zones.heating'))) {
                  const val = context.parsed.y;
                  let status = t('zone.heating_off');
                  if (val === 100) status = t('zone.heating_high');
                  else if (val === 50) status = t('zone.heating_medium');
                  else if (val === 20) status = t('zone.heating_low');
                  label += status;
                } else {
                  label += context.parsed.y.toFixed(0) + '%';
                }
              }
            }
            return label;
          }
        }
      }
    },
    scales: {
      x: {
        grid: {
          color: isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.04)',
        },
        ticks: {
          color: isLight ? '#64748b' : '#8a99ad',
          maxTicksLimit: 12,
          font: { family: 'Inter, sans-serif', size: 10 }
        }
      },
      y: {
        type: 'linear',
        display: showTemp,
        position: 'left',
        grid: {
          color: isLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.06)',
        },
        ticks: {
          color: isLight ? '#64748b' : '#8a99ad',
          font: { family: 'Inter, sans-serif', size: 10 },
          callback: function(value) {
            return value + '°';
          }
        }
      },
      y1: {
        type: 'linear',
        display: (showHumidity && hasValidHumidity) || showHeating || showSolar,
        position: 'right',
        grid: {
          drawOnChartArea: false,
        },
        min: 0,
        max: 100,
        ticks: {
          color: isLight ? '#64748b' : '#8a99ad',
          font: { family: 'Inter, sans-serif', size: 10 },
          callback: function(value) {
            return value + '%';
          }
        }
      }
    }
  };

  const slots = weather?.slots || {};
  const slotKeys = Object.keys(slots).sort();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
      {/* Weather slots row */}
      {slotKeys.length > 0 && (
        <div style={{
          display: 'flex',
          justify: 'space-around',
          alignItems: 'center',
          backgroundColor: isLight ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.08)',
          borderRadius: '16px',
          padding: '0.6rem 0.8rem',
          border: `1px solid ${isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.1)'}`,
          marginBottom: '0.25rem'
        }}>
          {slotKeys.map(time => {
            const slot = slots[time];
            return (
              <div key={time} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                <span style={{ fontSize: '0.65rem', color: isLight ? '#6b7280' : 'rgba(255, 255, 255, 0.6)', fontWeight: 600 }}>{time}</span>
                {getWeatherIcon(slot.state)}
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: isLight ? '#1f2937' : '#ffffff' }}>
                  {slot.temperature?.celsius?.toFixed(1)}°
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Visibility Select Toggles */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          onClick={() => setShowHeating(!showHeating)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '0.4rem 0.85rem',
            borderRadius: '20px',
            border: `1px solid ${isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.15)'}`,
            backgroundColor: showHeating ? (isDhw ? 'rgba(255, 122, 0, 0.15)' : 'rgba(255, 94, 98, 0.15)') : 'transparent',
            color: showHeating ? (isDhw ? '#ff7a00' : '#ff5e62') : (isLight ? '#6b7280' : 'rgba(255, 255, 255, 0.6)'),
            fontWeight: 600,
            fontSize: '0.8rem',
            cursor: 'pointer',
            transition: 'all 0.15s'
          }}
        >
          <Flame size={14} />
          <span>{isDhw ? t('schedule.hot_water_output') : t('dashboard.zones.heating')}</span>
        </button>

        <button
          onClick={() => setShowTemp(!showTemp)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '0.4rem 0.85rem',
            borderRadius: '20px',
            border: `1px solid ${isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.15)'}`,
            backgroundColor: showTemp ? 'rgba(0, 210, 255, 0.15)' : 'transparent',
            color: showTemp ? '#00d2ff' : (isLight ? '#6b7280' : 'rgba(255, 255, 255, 0.6)'),
            fontWeight: 600,
            fontSize: '0.8rem',
            cursor: 'pointer',
            transition: 'all 0.15s'
          }}
        >
          <Thermometer size={14} />
          <span>{t('common.temperature')}</span>
        </button>

        {!isDhw && (
          <button
            onClick={() => setShowHumidity(!showHumidity)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0.4rem 0.85rem',
              borderRadius: '20px',
              border: `1px solid ${isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.15)'}`,
              backgroundColor: showHumidity ? 'rgba(0, 180, 216, 0.15)' : 'transparent',
              color: showHumidity ? '#00b4d8' : (isLight ? '#6b7280' : 'rgba(255, 255, 255, 0.6)'),
              fontWeight: 600,
              fontSize: '0.8rem',
              cursor: 'pointer',
              transition: 'all 0.15s'
            }}
          >
            <Droplets size={14} />
            <span>{t('common.humidity')}</span>
          </button>
        )}

        <button
          onClick={() => setShowSolar(!showSolar)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '0.4rem 0.85rem',
            borderRadius: '20px',
            border: `1px solid ${isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.15)'}`,
            backgroundColor: showSolar ? 'rgba(255, 202, 40, 0.15)' : 'transparent',
            color: showSolar ? '#ffca28' : (isLight ? '#6b7280' : 'rgba(255, 255, 255, 0.6)'),
            fontWeight: 600,
            fontSize: '0.8rem',
            cursor: 'pointer',
            transition: 'all 0.15s'
          }}
        >
          <Sun size={14} />
          <span>{t('common.solar')}</span>
        </button>
      </div>

      <div style={{ height: '240px', width: '100%', position: 'relative', marginTop: '0.5rem' }}>
        <Line data={data} options={options} plugins={[presencePlugin]} />
      </div>
    </div>
  );
}

export default React.memo(CombinedTelemetryChart);

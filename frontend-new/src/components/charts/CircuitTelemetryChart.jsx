/**
 * @file src/components/charts/CircuitTelemetryChart.jsx
 * @brief Circuit telemetry chart displaying flow/return temperatures, modulation, circuit demand,
 * and individual zone heat requests mapping.
 * 
 * Implements ChartJS Line chart to visualize boiler circuit parameters alongside
 * concurrent zone heating demands, showing how zone heat requests contribute to circuit heating.
 */

import React, { useState, useContext, useMemo } from 'react';
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
import { Thermometer, Flame, Activity, Gauge, Home } from 'lucide-react';

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

const ZONE_COLORS = [
  '#38bdf8', // sky
  '#a78bfa', // purple
  '#f472b6', // pink
  '#34d399', // emerald
  '#fb923c', // orange
  '#e879f9', // fuchsia
  '#facc15', // yellow
  '#60a5fa', // blue
  '#4ade80', // green
  '#f87171'  // red
];

function CircuitTelemetryChart({ circuitDayReportData }) {
  const { t } = useTranslation();
  const themeContext = useContext(ThemeContext);
  const theme = themeContext?.resolvedTheme || 'dark';
  const isLight = theme === 'light';

  const [showFlowTemp, setShowFlowTemp] = useState(true);
  const [showReturnTemp, setShowReturnTemp] = useState(true);
  const [showSetpoint, setShowSetpoint] = useState(true);
  const [showCircuitDemand, setShowCircuitDemand] = useState(true);
  const [showModulation, setShowModulation] = useState(true);
  const [showZoneRequests, setShowZoneRequests] = useState(true);
  const [showPressure, setShowPressure] = useState(false);

  if (!circuitDayReportData) return null;

  const { measuredData, flameState, zoneHeatRequests = [] } = circuitDayReportData;
  const flowPoints = measuredData?.flowTemperature?.dataPoints || [];

  if (flowPoints.length === 0) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        {t('zone.no_telemetry_data', 'No telemetry data available for this date')}
      </div>
    );
  }

  // Format local HH:MM labels from timestamps
  const labels = flowPoints.map(pt => {
    const d = new Date(pt.timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  });

  const flowTemps = flowPoints.map(pt => pt.value);
  const returnTemps = (measuredData?.returnTemperature?.dataPoints || []).map(pt => pt.value);
  const setpointTemps = (measuredData?.controlSetpoint?.dataPoints || []).map(pt => pt.value);
  const demandValues = (measuredData?.circuitDemand?.dataPoints || []).map(pt => pt.value);
  const modulationValues = (measuredData?.modulation?.dataPoints || []).map(pt => pt.value);
  const pressureValues = (measuredData?.waterPressure?.dataPoints || []).map(pt => pt.value);

  const datasets = [];

  // 1. Flow Temperature
  if (showFlowTemp) {
    datasets.push({
      label: `${t('tanoclo_ex.ch_flow_temp', 'Flow Temp')} (°C)`,
      data: flowTemps,
      borderColor: '#f97316', // Orange
      backgroundColor: 'rgba(249, 115, 22, 0.08)',
      borderWidth: 2.5,
      pointRadius: 0,
      pointHoverRadius: 5,
      tension: 0.25,
      yAxisID: 'y',
    });
  }

  // 2. Return Temperature
  if (showReturnTemp) {
    datasets.push({
      label: `${t('tanoclo_ex.ch_return_temp', 'Return Temp')} (°C)`,
      data: returnTemps,
      borderColor: '#06b6d4', // Cyan
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [4, 4],
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.25,
      yAxisID: 'y',
    });
  }

  // 3. Control Setpoint
  if (showSetpoint) {
    datasets.push({
      label: `${t('tanoclo_ex.control_setpoint', 'Setpoint')} (°C)`,
      data: setpointTemps,
      borderColor: '#6366f1', // Indigo
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [2, 2],
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0,
      stepped: 'before',
      yAxisID: 'y',
    });
  }

  // 4. Circuit Demand %
  if (showCircuitDemand) {
    datasets.push({
      label: `${t('settings.heat_demand', 'Circuit Demand')} (%)`,
      data: demandValues,
      borderColor: '#ef4444', // Red
      backgroundColor: 'rgba(239, 68, 68, 0.12)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      stepped: 'before',
      fill: true,
      yAxisID: 'y1',
    });
  }

  // 5. Boiler Modulation %
  if (showModulation) {
    datasets.push({
      label: `${t('tanoclo_ex.relative_modulation', 'Modulation')} (%)`,
      data: modulationValues,
      borderColor: '#eab308', // Yellow
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.3,
      yAxisID: 'y1',
    });
  }

  // 6. Water Pressure
  if (showPressure) {
    datasets.push({
      label: `${t('tanoclo_ex.water_pressure', 'Water Pressure')} (bar)`,
      data: pressureValues,
      borderColor: '#10b981', // Emerald
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.2,
      yAxisID: 'yPressure',
    });
  }

  // 7. Zone Heat Requests (Attribution Mapping)
  if (showZoneRequests) {
    zoneHeatRequests.forEach((zEntry, idx) => {
      const color = ZONE_COLORS[idx % ZONE_COLORS.length];
      const zData = zEntry.dataPoints.map(p => p.value);
      datasets.push({
        label: `${zEntry.zoneName} ${t('zone.heating_demand', 'Heat')} (%)`,
        data: zData,
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [3, 3],
        pointRadius: 0,
        pointHoverRadius: 4,
        stepped: 'before',
        yAxisID: 'y1',
      });
    });
  }

  // Flame Shading Plugin (Burner active background shading)
  const flameShadingPlugin = {
    id: 'flameShading',
    beforeDraw: (chart) => {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const { top, bottom, left, right } = chartArea;
      const flameIntervals = flameState?.dataIntervals || [];

      flameIntervals.forEach(interval => {
        if (!interval.value) return; // Only shade when active
        const fromTime = new Date(interval.from).getTime();
        const toTime = new Date(interval.to).getTime();

        const getPixelForTime = (timeMs) => {
          if (flowPoints.length === 0) return left;
          const firstMs = new Date(flowPoints[0].timestamp).getTime();
          const lastMs = new Date(flowPoints[flowPoints.length - 1].timestamp).getTime();
          if (timeMs <= firstMs) return left;
          if (timeMs >= lastMs) return right;
          const ratio = (timeMs - firstMs) / (lastMs - firstMs);
          return left + ratio * (right - left);
        };

        const xStart = getPixelForTime(fromTime);
        const xEnd = getPixelForTime(toTime);

        ctx.save();
        ctx.fillStyle = isLight ? 'rgba(239, 68, 68, 0.08)' : 'rgba(239, 68, 68, 0.12)';
        ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);
        ctx.restore();
      });
    }
  };

  const chartData = { labels, datasets };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(20, 24, 33, 0.95)',
        titleColor: '#fff',
        bodyColor: '#e0e0e0',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        borderWidth: 1,
        titleFont: { family: 'Inter, sans-serif' },
        bodyFont: { family: 'Inter, sans-serif' },
        callbacks: {
          label: function (context) {
            let label = context.dataset.label || '';
            if (label) label += ': ';
            if (context.parsed.y !== null && context.parsed.y !== undefined) {
              if (context.dataset.yAxisID === 'y') {
                label += context.parsed.y.toFixed(1) + '°C';
              } else if (context.dataset.yAxisID === 'yPressure') {
                label += context.parsed.y.toFixed(2) + ' bar';
              } else {
                label += context.parsed.y.toFixed(0) + '%';
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
          color: isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)',
        },
        ticks: {
          color: isLight ? '#64748b' : '#94a3b8',
          maxTicksLimit: 12,
          font: { size: 10, family: 'Inter, sans-serif' }
        }
      },
      y: {
        type: 'linear',
        display: true,
        position: 'left',
        title: {
          display: true,
          text: `${t('common.temperature', 'Temperature')} (°C)`,
          color: isLight ? '#64748b' : '#94a3b8',
          font: { size: 11, weight: 600 }
        },
        grid: {
          color: isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)',
        },
        ticks: {
          color: isLight ? '#64748b' : '#94a3b8',
          font: { size: 10 }
        },
        suggestedMin: 20,
        suggestedMax: 70
      },
      y1: {
        type: 'linear',
        display: true,
        position: 'right',
        title: {
          display: true,
          text: `${t('settings.heat_demand', 'Demand')} / ${t('tanoclo_ex.relative_modulation', 'Modulation')} (%)`,
          color: isLight ? '#64748b' : '#94a3b8',
          font: { size: 11, weight: 600 }
        },
        min: 0,
        max: 100,
        grid: { drawOnChartArea: false },
        ticks: {
          color: isLight ? '#64748b' : '#94a3b8',
          stepSize: 20,
          font: { size: 10 }
        }
      },
      yPressure: {
        type: 'linear',
        display: showPressure,
        position: 'right',
        grid: { drawOnChartArea: false },
        min: 0,
        max: 3.5,
        ticks: { display: false }
      }
    }
  };

  // Compute summary stats for the day
  const maxFlow = Math.max(...flowTemps.filter(v => v !== null && v !== undefined), 0);
  const maxMod = Math.max(...modulationValues.filter(v => v !== null && v !== undefined), 0);
  const activeFlamePoints = (flameState?.dataIntervals || []).filter(i => i.value);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
      {/* Metric Toggles Bar */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          onClick={() => setShowFlowTemp(!showFlowTemp)}
          style={{
            padding: '0.3rem 0.65rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid',
            borderColor: showFlowTemp ? '#f97316' : 'var(--border-color)',
            backgroundColor: showFlowTemp ? 'rgba(249, 115, 22, 0.15)' : 'transparent',
            color: showFlowTemp ? '#f97316' : 'var(--text-muted)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem'
          }}
        >
          <Thermometer size={13} />
          <span>{t('tanoclo_ex.ch_flow_temp', 'Flow Temp')}</span>
        </button>

        <button
          onClick={() => setShowReturnTemp(!showReturnTemp)}
          style={{
            padding: '0.3rem 0.65rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid',
            borderColor: showReturnTemp ? '#06b6d4' : 'var(--border-color)',
            backgroundColor: showReturnTemp ? 'rgba(6, 182, 212, 0.15)' : 'transparent',
            color: showReturnTemp ? '#06b6d4' : 'var(--text-muted)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem'
          }}
        >
          <Thermometer size={13} />
          <span>{t('tanoclo_ex.ch_return_temp', 'Return Temp')}</span>
        </button>

        <button
          onClick={() => setShowSetpoint(!showSetpoint)}
          style={{
            padding: '0.3rem 0.65rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid',
            borderColor: showSetpoint ? '#6366f1' : 'var(--border-color)',
            backgroundColor: showSetpoint ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
            color: showSetpoint ? '#818cf8' : 'var(--text-muted)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem'
          }}
        >
          <Activity size={13} />
          <span>{t('tanoclo_ex.control_setpoint', 'Setpoint')}</span>
        </button>

        <button
          onClick={() => setShowCircuitDemand(!showCircuitDemand)}
          style={{
            padding: '0.3rem 0.65rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid',
            borderColor: showCircuitDemand ? '#ef4444' : 'var(--border-color)',
            backgroundColor: showCircuitDemand ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
            color: showCircuitDemand ? '#ef4444' : 'var(--text-muted)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem'
          }}
        >
          <Flame size={13} />
          <span>{t('settings.heat_demand', 'Circuit Demand')}</span>
        </button>

        <button
          onClick={() => setShowModulation(!showModulation)}
          style={{
            padding: '0.3rem 0.65rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid',
            borderColor: showModulation ? '#eab308' : 'var(--border-color)',
            backgroundColor: showModulation ? 'rgba(234, 179, 8, 0.15)' : 'transparent',
            color: showModulation ? '#eab308' : 'var(--text-muted)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem'
          }}
        >
          <Activity size={13} />
          <span>{t('tanoclo_ex.relative_modulation', 'Modulation')}</span>
        </button>

        <button
          onClick={() => setShowZoneRequests(!showZoneRequests)}
          style={{
            padding: '0.3rem 0.65rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid',
            borderColor: showZoneRequests ? 'var(--primary)' : 'var(--border-color)',
            backgroundColor: showZoneRequests ? 'var(--primary-glow)' : 'transparent',
            color: showZoneRequests ? 'var(--primary)' : 'var(--text-muted)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem'
          }}
        >
          <Home size={13} />
          <span>{t('settings.zone_contributions', 'Zone Heat Demands')}</span>
        </button>

        <button
          onClick={() => setShowPressure(!showPressure)}
          style={{
            padding: '0.3rem 0.65rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid',
            borderColor: showPressure ? '#10b981' : 'var(--border-color)',
            backgroundColor: showPressure ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
            color: showPressure ? '#10b981' : 'var(--text-muted)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem'
          }}
        >
          <Gauge size={13} />
          <span>{t('tanoclo_ex.water_pressure', 'Pressure')}</span>
        </button>
      </div>

      {/* Main Chart Area */}
      <div style={{ height: '320px', width: '100%', position: 'relative' }}>
        <Line data={chartData} options={chartOptions} plugins={[flameShadingPlugin]} />
      </div>

      {/* Zone Heat Attribution Legend Bar */}
      {zoneHeatRequests.length > 0 && showZoneRequests && (
        <div style={{
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
          alignItems: 'center',
          padding: '0.6rem 0.85rem',
          backgroundColor: 'var(--bg-input)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-color)',
          fontSize: '0.75rem'
        }}>
          <strong style={{ color: 'var(--text-secondary)' }}>
            {t('settings.mapped_zone_heat_requests', 'Mapped Room Heat Demands')}:
          </strong>
          {zoneHeatRequests.map((z, idx) => {
            const color = ZONE_COLORS[idx % ZONE_COLORS.length];
            const avgDemand = Math.round(
              z.dataPoints.reduce((acc, p) => acc + (p.value || 0), 0) / (z.dataPoints.length || 1)
            );
            return (
              <div key={z.zoneId} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: color }} />
                <span>{z.zoneName}:</span>
                <strong style={{ color }}>{avgDemand}% avg</strong>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default React.memo(CircuitTelemetryChart);

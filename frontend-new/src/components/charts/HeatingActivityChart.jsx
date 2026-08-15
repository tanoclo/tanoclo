/**
 * @file src/components/charts/HeatingActivityChart.jsx
 * @brief Stacked bar chart showing total daily/monthly boiler running times distributed across rooms.
 * 
 * Includes a breakdown doughnut chart displaying overall zone heat consumption percentages,
 * custom mouse-follow tooltip repositioning hooks, and localized calendar time formats.
 */

import React from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';
import Card from '../common/Card';
import { useTranslation } from 'react-i18next';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
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

function HeatingActivityChart({ runningTimesData, zones = [], aggregate = 'day' }) {
  const { t } = useTranslation();
  if (!runningTimesData) return null;

  const { summary, runningTimes = [] } = runningTimesData;

  const totalHours = summary?.totalRunningTimeInSeconds 
    ? (summary.totalRunningTimeInSeconds / 3600).toFixed(1) 
    : '0.0';

  const meanHours = summary?.meanInSecondsPerDay 
    ? (summary.meanInSecondsPerDay / 3600).toFixed(1) 
    : '0.0';

  if (runningTimes.length === 0) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        {t('heating_activity.no_data')}
      </div>
    );
  }

  // 1. Prepare Labels (e.g. Month name or Day date)
  const labels = runningTimes.map(bucket => {
    const d = new Date(bucket.startTime.replace(' ', 'T') + 'Z');
    if (aggregate === 'month') {
      return d.toLocaleDateString([], { month: 'short', year: 'numeric', timeZone: 'UTC' });
    } else {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
  });

  // 2. Prepare Datasets (one dataset per zone for stacked bar chart)
  // Get all unique zone IDs present in the data
  const zoneIdSet = new Set();
  runningTimes.forEach(bucket => {
    bucket.zones?.forEach(z => zoneIdSet.add(z.id));
  });
  const activeZoneIds = Array.from(zoneIdSet);

  // Map zone IDs to metadata names
  const getZoneName = (id) => {
    const match = zones.find(z => z.id === id);
    return match ? match.name : `Zone ${id}`;
  };

  // Harmonious colors for zones
  const colors = [
    '#ff7e5f', // Coral
    '#feb47b', // Soft orange
    '#2b90d9', // Blue
    '#4caf50', // Green
    '#9c27b0', // Purple
    '#ffeb3b', // Yellow
    '#e91e63', // Pink
    '#00bcd4', // Cyan
  ];

  // Map each active zone to a dataset
  const datasets = activeZoneIds.map((zoneId, idx) => {
    const color = colors[idx % colors.length];
    
    // For each bucket, get this zone's hours
    const dataPoints = runningTimes.map(bucket => {
      const zData = bucket.zones?.find(z => z.id === zoneId);
      return zData ? parseFloat((zData.runningTimeInSeconds / 3600).toFixed(2)) : 0;
    });

    return {
      label: getZoneName(zoneId),
      data: dataPoints,
      backgroundColor: color,
      borderColor: 'transparent',
      borderRadius: 4,
    };
  });

  const chartData = {
    labels,
    datasets
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: '#e0e0e0',
          boxWidth: 10,
          font: { family: 'Inter, sans-serif', size: 10 }
        }
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
            return `${context.dataset.label}: ${t('heating_activity.hours_count', { count: context.parsed.y.toFixed(1) })}`;
          }
        }
      }
    },
    scales: {
      x: {
        stacked: true,
        grid: { color: 'rgba(255, 255, 255, 0.04)' },
        ticks: { color: '#8a99ad', font: { family: 'Inter, sans-serif', size: 9 } }
      },
      y: {
        stacked: true,
        grid: { color: 'rgba(255, 255, 255, 0.06)' },
        ticks: {
          color: '#8a99ad',
          font: { family: 'Inter, sans-serif', size: 9 },
          callback: function(value) { return `${value} ${t('heating_activity.hrs')}`; }
        }
      }
    }
  };

  // 3. Compute overall breakdown statistics for the summary breakdown list
  const zoneTotals = {};
  let totalZoneSeconds = 0;
  activeZoneIds.forEach(id => { zoneTotals[id] = 0; });

  runningTimes.forEach(bucket => {
    bucket.zones?.forEach(z => {
      if (zoneTotals[z.id] !== undefined) {
        zoneTotals[z.id] += z.runningTimeInSeconds;
        totalZoneSeconds += z.runningTimeInSeconds;
      }
    });
  });

  // Sort zones by total heating time descending
  const zoneBreakdown = activeZoneIds
    .map((zoneId, idx) => {
      const seconds = zoneTotals[zoneId];
      const percent = totalZoneSeconds > 0 ? Math.round((seconds / totalZoneSeconds) * 100) : 0;
      return {
        id: zoneId,
        name: getZoneName(zoneId),
        hours: (seconds / 3600).toFixed(1),
        percent,
        color: colors[idx % colors.length]
      };
    })
    .sort((a, b) => b.percent - a.percent);

  const doughnutData = {
    labels: zoneBreakdown.map(z => z.name),
    datasets: [{
      data: zoneBreakdown.map(z => parseFloat(z.hours)),
      backgroundColor: zoneBreakdown.map(z => z.color),
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.1)',
    }]
  };

  const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        backgroundColor: 'rgba(20, 24, 33, 0.95)',
        titleColor: '#fff',
        bodyColor: '#e0e0e0',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        borderWidth: 1,
        callbacks: {
          label: function(context) {
            return `${context.label}: ${t('heating_activity.hours_count', { count: context.parsed.toFixed(1) })}`;
          }
        }
      }
    },
    cutout: '65%'
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%' }}>
      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <Card style={{ padding: '1rem', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
            {t('heating_activity.total_heating_time')}
          </span>
          <span style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--primary)', marginTop: '0.25rem' }}>
            {t('heating_activity.hours_short', { count: totalHours })}
          </span>
        </Card>
        <Card style={{ padding: '1rem', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
            {aggregate === 'month' ? t('heating_activity.mean_month') : t('heating_activity.mean_day')}
          </span>
          <span style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--secondary)', marginTop: '0.25rem' }}>
            {t('heating_activity.hours_short', { count: meanHours })}
          </span>
        </Card>
      </div>

      {/* Stacked Bar Chart */}
      <Card style={{ padding: '1.25rem' }}>
        <div style={{ height: '280px', position: 'relative' }}>
          <Bar data={chartData} options={chartOptions} />
        </div>
      </Card>

      {/* Room Breakdown Section */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700 }}>
          {t('heating_activity.activity_per_room')}
        </h4>

        {/* Doughnut Chart representation */}
        <div style={{ height: '140px', position: 'relative', margin: '0.5rem 0' }}>
          <Doughnut data={doughnutData} options={doughnutOptions} />
        </div>

        {/* Breakdown List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {zoneBreakdown.map((item) => (
            <div 
              key={item.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: '0.875rem'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  backgroundColor: item.color
                }} />
                <span>{item.name}</span>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', color: 'var(--text-secondary)' }}>
                <span>{t('heating_activity.hours_count', { count: item.hours })}</span>
                <strong style={{ color: 'var(--text-primary)', width: '36px', textAlign: 'right' }}>
                  {item.percent}%
                </strong>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export default React.memo(HeatingActivityChart);

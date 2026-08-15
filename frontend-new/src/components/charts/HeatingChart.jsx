/**
 * @file src/components/charts/HeatingChart.jsx
 * @brief Renders the historical boiler heat demand (call for heat) stepped line chart.
 * 
 * Maps categorical demand states (HIGH, MEDIUM, LOW, NONE) to percentage levels
 * (100, 50, 20, 0) and plots them on a stepped chronological timeline.
 */


import { Line } from 'react-chartjs-2';
import { useTranslation } from 'react-i18next';

/**
 * @brief Renders the Heating activity stepped line chart.
 * @param {object} props.dayReportData - Unified report object containing measuredData and callForHeat parameters.
 */
export default function HeatingChart({ dayReportData }) {
  const { t } = useTranslation();
  if (!dayReportData) return null;

  const { measuredData, callForHeat } = dayReportData;
  const insideTempPoints = measuredData?.insideTemperature?.dataPoints || [];

  if (insideTempPoints.length === 0) {
    return (
      <div style={{
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--text-secondary)'
      }}>
        {t('zone.no_heating_demand_data')}
      </div>
    );
  }

  const labels = insideTempPoints.map(pt => {
    const d = new Date(pt.timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  });

  // Map callForHeat intervals to values aligned with temperature timestamps
  const demandValues = insideTempPoints.map(pt => {
    const ts = new Date(pt.timestamp).getTime();
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
  });

  const data = {
    labels,
    datasets: [
      {
        label: t('zone.heating_demand'),
        data: demandValues,
        borderColor: '#ff5e62',
        backgroundColor: 'rgba(255, 94, 98, 0.15)',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.2,
        fill: true,
        stepped: 'before' // Show as stepped stages
      }
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
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
            const val = context.parsed.y;
            let status = t('zone.heating_off');
            if (val === 100) status = t('zone.heating_high');
            else if (val === 50) status = t('zone.heating_medium');
            else if (val === 20) status = t('zone.heating_low');
            return `${t('zone.heating_demand')}: ${status}`;
          }
        }
      }
    },
    scales: {
      x: {
        grid: {
          color: 'rgba(255, 255, 255, 0.04)',
        },
        ticks: {
          color: '#8a99ad',
          maxTicksLimit: 12,
          font: {
            family: 'Inter, sans-serif',
            size: 10
          }
        }
      },
      y: {
        grid: {
          color: 'rgba(255, 255, 255, 0.06)',
        },
        min: 0,
        max: 100,
        ticks: {
          color: '#8a99ad',
          stepSize: 20,
          font: {
            family: 'Inter, sans-serif',
            size: 10
          },
          callback: function(value) {
            if (value === 0) return t('zone.heating_off');
            if (value === 20) return t('common.low');
            if (value === 50) return t('common.normal');
            if (value === 100) return t('common.high');
            return '';
          }
        }
      }
    }
  };

  return (
    <div style={{ height: '180px', width: '100%', position: 'relative' }}>
      <Line data={data} options={options} />
    </div>
  );
}

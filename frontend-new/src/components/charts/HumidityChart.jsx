/**
 * @file src/components/charts/HumidityChart.jsx
 * @brief Renders the historical indoor room relative humidity percentage line chart.
 * 
 * Maps decimal ratio values (e.g. 0.55) to percentages (55%) and plots them
 * over the report timeframe with gridline bounds.
 */


import { Line } from 'react-chartjs-2';
import { useTranslation } from 'react-i18next';

/**
 * @brief Renders the Humidity level line chart.
 * @param {object} props.dayReportData - Unified report object containing measuredData details.
 */
export default function HumidityChart({ dayReportData }) {
  const { t } = useTranslation();
  if (!dayReportData) return null;

  const { measuredData } = dayReportData;
  const humidityPoints = measuredData?.humidity?.dataPoints || [];

  if (humidityPoints.length === 0) {
    return (
      <div style={{
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--text-secondary)'
      }}>
        {t('zone.no_humidity_data')}
      </div>
    );
  }

  const labels = humidityPoints.map(pt => {
    const d = new Date(pt.timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  });

  const humidityValues = humidityPoints.map(pt => pt.value * 100);

  const data = {
    labels,
    datasets: [
      {
        label: t('common.humidity'),
        data: humidityValues,
        borderColor: '#00b4d8',
        backgroundColor: 'rgba(0, 180, 216, 0.05)',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.3,
        fill: true,
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
            return `${t('common.humidity')}: ${context.parsed.y.toFixed(0)}%`;
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
          font: {
            family: 'Inter, sans-serif',
            size: 10
          },
          callback: function(value) {
            return value + '%';
          }
        }
      }
    }
  };

  return (
    <div style={{ height: '200px', width: '100%', position: 'relative' }}>
      <Line data={data} options={options} />
    </div>
  );
}

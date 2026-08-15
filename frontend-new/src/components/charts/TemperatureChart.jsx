/**
 * @file src/components/charts/TemperatureChart.jsx
 * @brief Renders the comparative temperature line chart.
 * 
 * Plots inside room temperature, stepped target setpoint temperatures,
 * and external outside weather temperature readings concurrently.
 */


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

/**
 * @brief Unified inside, outside and target temperatures chart.
 * @param {object} props.dayReportData - Unified report object containing measuredData, settings, and weather parameters.
 */
export default function TemperatureChart({ dayReportData }) {
  const { t } = useTranslation();
  if (!dayReportData) return null;

  const { measuredData, settings, weather } = dayReportData;
  const insideTempPoints = measuredData?.insideTemperature?.dataPoints || [];
  
  if (insideTempPoints.length === 0) {
    return (
      <div style={{
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--text-secondary)'
      }}>
        {t('zone.no_temp_data')}
      </div>
    );
  }

  // Format local HH:MM labels from timestamps
  const labels = insideTempPoints.map(pt => {
    const d = new Date(pt.timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  });

  // 1. Inside Temperature
  const insideTemps = insideTempPoints.map(pt => pt.value?.celsius);

  // 2. Target Temperature (aligned with insideTempPoints timestamps)
  const targetTemps = insideTempPoints.map(pt => {
    const ts = new Date(pt.timestamp).getTime();
    // Find the active setting interval
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

  const data = {
    labels,
    datasets: [
      {
        label: t('zone.inside_temp'),
        data: insideTemps,
        borderColor: '#00d2ff',
        backgroundColor: 'rgba(0, 210, 255, 0.05)',
        borderWidth: 3,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.3,
        fill: true,
      },
      {
        label: t('zone.target_temp_short'),
        data: targetTemps,
        borderColor: '#ff8a00',
        borderWidth: 2,
        borderDash: [5, 5],
        pointRadius: 0,
        pointHoverRadius: 4,
        stepped: 'before',
        tension: 0,
        fill: false,
      },
      {
        label: t('zone.outside_temp_short'),
        data: outsideTemps,
        borderColor: 'rgba(255, 255, 255, 0.35)',
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.3,
        fill: false,
      }
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top',
        labels: {
          color: '#e0e0e0',
          font: {
            family: 'Inter, sans-serif',
            size: 11
          },
          boxWidth: 12
        }
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
            let label = context.dataset.label || '';
            if (label) {
              label += ': ';
            }
            if (context.parsed.y !== null) {
              label += context.parsed.y.toFixed(1) + '°C';
            }
            return label;
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
        ticks: {
          color: '#8a99ad',
          font: {
            family: 'Inter, sans-serif',
            size: 10
          },
          callback: function(value) {
            return value + '°';
          }
        }
      }
    }
  };

  return (
    <div style={{ height: '300px', width: '100%', position: 'relative' }}>
      <Line data={data} options={options} />
    </div>
  );
}

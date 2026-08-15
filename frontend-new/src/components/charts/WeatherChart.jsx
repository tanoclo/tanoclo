/**
 * @file src/components/charts/WeatherChart.jsx
 * @brief Line chart displaying historical outdoor temperatures and solar intervals.
 * 
 * Maps outside temperature intervals and sunny duration flags directly onto the timeline
 * of the room's inside temperature data points for comparative heat retention analysis.
 */

import React from 'react';
import { Line } from 'react-chartjs-2';
import { useTranslation } from 'react-i18next';

/**
 * @brief Renders the Weather activity line chart.
 * @param {object} props.dayReportData - Unified report object containing measuredData and weather.
 */
function WeatherChart({ dayReportData }) {
  const { t } = useTranslation();
  if (!dayReportData) return null;

  const { measuredData, weather } = dayReportData;
  const insideTempPoints = measuredData?.insideTemperature?.dataPoints || [];

  if (insideTempPoints.length === 0) {
    return (
      <div style={{
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--text-secondary)'
      }}>
        {t('zone.no_weather_telemetry')}
      </div>
    );
  }

  const labels = insideTempPoints.map(pt => {
    const d = new Date(pt.timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  });

  // Align Outside Temp with insideTempPoints timestamps
  const outsideTemps = insideTempPoints.map(pt => {
    const ts = new Date(pt.timestamp).getTime();
    const activeWeather = weather?.condition?.dataIntervals?.find(interval => {
      const from = new Date(interval.from).getTime();
      const to = new Date(interval.to).getTime();
      return ts >= from && ts <= to;
    });
    return activeWeather?.value?.temperature?.celsius ?? null;
  });

  // Align Sunny indicator with insideTempPoints timestamps
  const sunnyValues = insideTempPoints.map(pt => {
    const ts = new Date(pt.timestamp).getTime();
    const activeSunny = weather?.sunny?.dataIntervals?.find(interval => {
      const from = new Date(interval.from).getTime();
      const to = new Date(interval.to).getTime();
      return ts >= from && ts <= to;
    });
    return activeSunny?.value ? 1 : 0;
  });

  const data = {
    labels,
    datasets: [
      {
        label: t('zone.outside_temperature'),
        data: outsideTemps,
        borderColor: '#a8c0e0',
        backgroundColor: 'rgba(168, 192, 224, 0.05)',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.3,
        fill: false,
        yAxisID: 'y'
      },
      {
        label: t('zone.sunny_interval'),
        data: sunnyValues,
        borderColor: 'rgba(255, 186, 0, 0.4)',
        backgroundColor: 'rgba(255, 186, 0, 0.12)',
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 0,
        stepped: 'before',
        fill: true,
        yAxisID: 'ySunny'
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
            const label = context.dataset.label || '';
            if (context.datasetIndex === 0) {
              return `${label}: ${context.parsed.y.toFixed(1)}°C`;
            } else {
              return `${label}: ${context.parsed.y === 1 ? t('common.yes') : t('common.no')}`;
            }
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
        type: 'linear',
        display: true,
        position: 'left',
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
      },
      ySunny: {
        type: 'linear',
        display: false, // Don't show y-axis for sunny boolean
        position: 'right',
        min: 0,
        max: 5, // Keep the sunny area low on the chart height
        grid: {
          drawOnChartArea: false
        }
      }
    }
  };

  return (
    <div style={{ height: '220px', width: '100%', position: 'relative' }}>
      <Line data={data} options={options} />
    </div>
  );
}

export default React.memo(WeatherChart);

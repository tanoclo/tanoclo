/**
 * @file src/components/settings/SupplyTempSettings.jsx
 * @brief Renders the Boiler Supply Flow Temperature settings form.
 * 
 * Interacts with SWR fetching curves on maxFlowTemperature ranges (30-80°C)
 * and enabling autoAdaptation learning models based on building thermal latency feedback.
 */

import { SWR_KEYS } from '../../utils/swrKeys';
import { useState, useEffect } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import Button from '../common/Button';
import Spinner from '../common/Spinner';
import Toggle from '../common/Toggle';
import Slider from '../common/Slider';
import { getSupplyTemperatureOptimization, updateSupplyTemperatureOptimization } from '../../api/heating';
import { Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import logger from '../../utils/logger';
import { useToast } from '../../context/ToastContext';

/**
 * @brief Supply temperature optimization settings panel.
 * @param {number} props.homeId - Active home identifier.
 */
export default function SupplyTempSettings({ homeId }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { data: optData, error, mutate } = useSWR(
    homeId ? SWR_KEYS.supplyTempOptimization(homeId) : null,
    () => getSupplyTemperatureOptimization(homeId)
  );

  const [maxTemp, setMaxTemp] = useState(60);
  const [autoAdapt, setAutoAdapt] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (optData) {
      setMaxTemp(prev => prev !== (optData.maxFlowTemperature ?? 60) ? (optData.maxFlowTemperature ?? 60) : prev);
      setAutoAdapt(prev => prev !== (optData.autoAdaptation?.enabled ?? false) ? (optData.autoAdaptation?.enabled ?? false) : prev);
    }
  }, [optData]);

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const payload = {
        maxFlowTemperature: maxTemp,
        autoAdaptation: {
          enabled: autoAdapt
        }
      };
      await updateSupplyTemperatureOptimization(homeId, payload);
      await mutate();
      showToast(t('settings.flow_temp_saved'), 'success');
    } catch (err) {
      logger.error('Failed to save supply temperature optimization settings:', err);
    } finally {
      setIsSaving(false);
    }
  };

  if (error) return <div style={{ color: 'var(--danger)', padding: '1rem' }}>{t('settings.flow_temp_failed_load')}</div>;
  if (!optData) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
        <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.flow_temp_opt')}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
            {t('settings.flow_temp_opt_desc')}
          </p>
        </div>
        <div style={{ padding: '3rem', textAlign: 'center' }}><Spinner size={24} /></div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.flow_temp_opt')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
          {t('settings.flow_temp_opt_desc')}
        </p>
      </div>

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        
        {/* Maximum Flow Temperature slider */}
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.max_flow_temp')}</h3>
            <span style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--primary)' }}>
              {maxTemp}°C
            </span>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.max_flow_temp_desc')}
          </p>
          <Slider
            min={30}
            max={80}
            step={1}
            value={maxTemp}
            onChange={setMaxTemp}
          />
        </Card>

        {/* Auto adaptation toggle */}
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong style={{ fontSize: '0.95rem', fontWeight: 700 }}>{t('settings.auto_adaptation')}</strong>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                {t('settings.auto_adaptation_desc')}
              </p>
            </div>
            <Toggle checked={autoAdapt} onChange={setAutoAdapt} />
          </div>
        </Card>

        <Button 
          type="submit" 
          variant="primary" 
          disabled={isSaving}
          style={{ alignSelf: 'flex-end' }}
        >
          <Save size={16} />
          <span>{isSaving ? t('settings.saving') : t('settings.save_settings')}</span>
        </Button>
      </form>

    </div>
  );
}

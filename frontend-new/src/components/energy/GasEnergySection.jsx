/**
 * @file src/components/energy/GasEnergySection.jsx
 * @brief Gas consumption, DHW vs heating split, per-room cost attribution, and MQTT settings panel.
 */

import { useState } from 'react';
import useSWR, { mutate } from 'swr';
import { useTranslation } from 'react-i18next';
import Card from '../common/Card';
import Button from '../common/Button';
import Badge from '../common/Badge';
import Modal from '../common/Modal';
import Spinner from '../common/Spinner';
import { getGasEnergyUsage, getGasEnergySettings, updateGasEnergySettings, postGasMeterReading } from '../../api/heating';
import { SWR_KEYS } from '../../utils/swrKeys';

export default function GasEnergySection({ homeId, zones = [] }) {
  const { t } = useTranslation();

  const getPastDateStr = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toLocaleDateString('sv'); // YYYY-MM-DD
  };
  const getTodayStr = () => new Date().toLocaleDateString('sv');

  const [fromDate, setFromDate] = useState(getPastDateStr(30));
  const [toDate, setToDate] = useState(getTodayStr());
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showReadingModal, setShowReadingModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Settings form states
  const [formSettings, setFormSettings] = useState(null);
  const [manualReading, setManualReading] = useState('');
  const [manualCost, setManualCost] = useState('');

  const { data: usageData, error: usageError, isLoading: isUsageLoading } = useSWR(
    homeId && fromDate && toDate ? SWR_KEYS.gasEnergyUsage(homeId, fromDate, toDate) : null,
    () => getGasEnergyUsage(homeId, { from: fromDate, to: toDate })
  );

  const { data: energySettings } = useSWR(
    homeId ? SWR_KEYS.gasEnergySettings(homeId) : null,
    () => getGasEnergySettings(homeId),
    {
      onSuccess: (data) => {
        if (!formSettings && data) {
          setFormSettings({
            gas_meter_topic: data.gas_meter_topic || '',
            gas_cost_topic: data.gas_cost_topic || '',
            gas_unit_cost: data.gas_unit_cost !== undefined ? data.gas_unit_cost : 1.45,
            currency: data.currency || '€',
            allocation_method: data.allocation_method || 'demand',
            calorific_value_kwh_per_m3: data.calorific_value_kwh_per_m3 || 10.0
          });
        }
      }
    }
  );

  const handleOpenConfig = () => {
    if (energySettings) {
      setFormSettings({
        gas_meter_topic: energySettings.gas_meter_topic || '',
        gas_cost_topic: energySettings.gas_cost_topic || '',
        gas_unit_cost: energySettings.gas_unit_cost !== undefined ? energySettings.gas_unit_cost : 1.45,
        currency: energySettings.currency || '€',
        allocation_method: energySettings.allocation_method || 'demand',
        calorific_value_kwh_per_m3: energySettings.calorific_value_kwh_per_m3 || 10.0
      });
    }
    setShowConfigModal(true);
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    if (!formSettings) return;
    setIsSaving(true);
    try {
      await updateGasEnergySettings(homeId, formSettings);
      await mutate(SWR_KEYS.gasEnergySettings(homeId));
      await mutate(SWR_KEYS.gasEnergyUsage(homeId, fromDate, toDate));
      setShowConfigModal(false);
    } catch (err) {
      console.error('Failed to update gas energy settings:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handlePostReading = async (e) => {
    e.preventDefault();
    const val = parseFloat(manualReading);
    if (isNaN(val) || val < 0) return;
    setIsSaving(true);
    try {
      await postGasMeterReading(homeId, {
        meter_m3: val,
        unit_cost: manualCost ? parseFloat(manualCost) : null
      });
      await mutate(SWR_KEYS.gasEnergySettings(homeId));
      await mutate(SWR_KEYS.gasEnergyUsage(homeId, fromDate, toDate));
      setManualReading('');
      setManualCost('');
      setShowReadingModal(false);
    } catch (err) {
      console.error('Failed to post manual meter reading:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const totals = usageData?.totals || {};
  const dhw = usageData?.dhw || {};
  const heating = usageData?.heating || {};
  const meterReading = usageData?.meterReading || {};
  const currency = totals.currency || '€';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', width: '100%' }}>
      {/* Header bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '0.75rem'
      }}>
        <div>
          <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>🔥</span>
            {t('settings.energy.gas_title', 'Gas Consumption & Costs')}
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: '0.2rem 0 0' }}>
            {t('settings.energy.gas_desc', 'OpenTherm DHW vs Space Heating attribution and per-room cost distribution.')}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {/* Date range picker */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.3rem 0.5rem',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.8rem',
                fontWeight: 600
              }}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('common.to', 'to')}</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.3rem 0.5rem',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.8rem',
                fontWeight: 600
              }}
            />
          </div>

          <Button variant="secondary" size="sm" onClick={handleOpenConfig} style={{ fontSize: '0.75rem' }}>
            ⚙️ {t('settings.energy.title', 'Tariff & MQTT')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowReadingModal(true)} style={{ fontSize: '0.75rem' }}>
            📝 {t('settings.energy.record_reading', 'Log Meter')}
          </Button>
        </div>
      </div>

      {isUsageLoading ? (
        <Card style={{ padding: '2rem', display: 'flex', justifyContent: 'center' }}>
          <Spinner size={24} />
        </Card>
      ) : usageError ? (
        <Card style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--danger)' }}>
          {t('common.error_loading', 'Failed to load gas energy measurements')}
        </Card>
      ) : (
        <>
          {/* KPI Summary Cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '0.75rem'
          }}>
            {/* Total Gas */}
            <Card style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  {t('settings.energy.total_gas', 'Total Gas')}
                </span>
                <Badge variant={meterReading.isEstimated ? 'warning' : 'success'}>
                  {meterReading.isEstimated
                    ? t('settings.energy.estimated_badge', 'Estimated')
                    : t('settings.energy.meter_badge', 'Meter Verified')}
                </Badge>
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                {totals.totalM3 !== undefined ? totals.totalM3.toFixed(2) : '0.00'} <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>m³</span>
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                {currency}{totals.totalCost !== undefined ? totals.totalCost.toFixed(2) : '0.00'} • {totals.totalKwh || 0} kWh
              </div>
            </Card>

            {/* DHW */}
            <Card style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <span>🚿</span> {t('settings.energy.dhw_gas', 'Hot Water (DHW)')}
                </span>
                <Badge variant="info">
                  {dhw.percentage !== undefined ? `${dhw.percentage}%` : '0%'}
                </Badge>
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#38bdf8' }}>
                {dhw.m3 !== undefined ? dhw.m3.toFixed(2) : '0.00'} <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>m³</span>
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                {currency}{dhw.cost !== undefined ? dhw.cost.toFixed(2) : '0.00'} • {t('settings.energy.opentherm_dhw', 'OpenTherm')}
              </div>
            </Card>

            {/* Central Heating */}
            <Card style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <span>🏠</span> {t('settings.energy.heating_gas', 'Central Heating')}
                </span>
                <Badge variant="neutral">
                  {heating.percentage !== undefined ? `${heating.percentage}%` : '0%'}
                </Badge>
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#fb923c' }}>
                {heating.m3 !== undefined ? heating.m3.toFixed(2) : '0.00'} <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>m³</span>
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                {currency}{heating.cost !== undefined ? heating.cost.toFixed(2) : '0.00'} • {usageData?.zones?.length || 0} rooms
              </div>
            </Card>

            {/* Tariff / Reading */}
            <Card style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  {t('settings.energy.tariff', 'Gas Tariff')}
                </span>
                <Badge variant="neutral">
                  {usageData?.allocationMethod === 'area_weighted' ? 'Area-Weighted' : 'Demand-Based'}
                </Badge>
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                {currency}{totals.unitCost !== undefined ? totals.unitCost.toFixed(2) : '1.45'}<span style={{ fontSize: '0.85rem', fontWeight: 500 }}>/m³</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {meterReading.end?.meterM3 ? `Last: ${meterReading.end.meterM3.toFixed(1)} m³` : 'MQTT Ready'}
              </div>
            </Card>
          </div>

          {/* Visual Distribution Bar */}
          {totals.totalM3 > 0 && (
            <Card style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: 600 }}>
                <span style={{ color: '#38bdf8' }}>🚿 DHW: {dhw.m3?.toFixed(2)} m³ ({dhw.percentage}%)</span>
                <span style={{ color: '#fb923c' }}>🏠 Space Heating: {heating.m3?.toFixed(2)} m³ ({heating.percentage}%)</span>
              </div>
              <div style={{
                height: '10px',
                width: '100%',
                backgroundColor: 'var(--bg-input)',
                borderRadius: '6px',
                display: 'flex',
                overflow: 'hidden'
              }}>
                <div style={{
                  width: `${dhw.percentage || 0}%`,
                  backgroundColor: '#38bdf8',
                  transition: 'width var(--transition-normal)'
                }} />
                <div style={{
                  width: `${heating.percentage || 0}%`,
                  backgroundColor: '#fb923c',
                  transition: 'width var(--transition-normal)'
                }} />
              </div>
            </Card>
          )}

          {/* Space Heating by Room Breakdown */}
          <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
                {t('settings.energy.room_breakdown', 'Space Heating Breakdown by Room')}
              </h4>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {usageData?.allocationMethod === 'area_weighted'
                  ? t('settings.energy.allocation_area_hint', 'Weighted by valve demand × room area (m²)')
                  : t('settings.energy.allocation_demand_hint', 'Weighted by valve duty cycle over time')}
              </span>
            </div>

            {usageData?.zones && usageData.zones.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {usageData.zones.map((z) => (
                  <div
                    key={z.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.35rem',
                      padding: '0.6rem 0.8rem',
                      backgroundColor: 'var(--bg-input)',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-color)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                          {z.name}
                        </span>
                        {z.roomSizeSqm && (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            ({z.roomSizeSqm} m²)
                          </span>
                        )}
                        <Badge variant="neutral" style={{ fontSize: '0.7rem' }}>
                          {z.heatingType || 'RADIATOR'}
                        </Badge>
                      </div>

                      <div style={{ textAlign: 'right' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                          {currency}{z.cost?.toFixed(2)}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginLeft: '0.4rem' }}>
                          ({z.m3?.toFixed(2)} m³ • {z.percentage}%)
                        </span>
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div style={{
                      height: '6px',
                      width: '100%',
                      backgroundColor: 'var(--bg-card)',
                      borderRadius: '3px',
                      overflow: 'hidden'
                    }}>
                      <div
                        style={{
                          width: `${Math.min(100, z.percentage || 0)}%`,
                          height: '100%',
                          backgroundColor: '#fb923c',
                          borderRadius: '3px',
                          transition: 'width var(--transition-normal)'
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '1rem', fontSize: '0.85rem' }}>
                {t('zone.no_zones', 'No heating zones configured')}
              </div>
            )}
          </Card>
        </>
      )}

      {/* Settings Modal */}
      {showConfigModal && formSettings && (
        <Modal
          isOpen={showConfigModal}
          onClose={() => setShowConfigModal(false)}
          title={t('settings.energy.title', 'Gas Energy & Tariff Settings')}
        >
          <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.3rem' }}>
                {t('settings.energy.gas_meter_topic', 'Gas Meter MQTT Topic (m³)')}
              </label>
              <input
                type="text"
                value={formSettings.gas_meter_topic}
                onChange={(e) => setFormSettings({ ...formSettings, gas_meter_topic: e.target.value })}
                placeholder={`tado/tanoclo/h/${homeId}/energy/gas_meter`}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontSize: '0.85rem'
                }}
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Ingests cumulative gas meter readings (e.g. from Home Assistant P1 sensor).
              </span>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.3rem' }}>
                {t('settings.energy.gas_cost_topic', 'Gas Tariff MQTT Topic (€/m³)')}
              </label>
              <input
                type="text"
                value={formSettings.gas_cost_topic}
                onChange={(e) => setFormSettings({ ...formSettings, gas_cost_topic: e.target.value })}
                placeholder={`tado/tanoclo/h/${homeId}/energy/gas_cost_per_m3`}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontSize: '0.85rem'
                }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.3rem' }}>
                  {t('settings.energy.unit_cost', 'Gas Tariff / Unit Cost')}
                </label>
                <input
                  type="number"
                  step="0.0001"
                  value={formSettings.gas_unit_cost}
                  onChange={(e) => setFormSettings({ ...formSettings, gas_unit_cost: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-primary)',
                    fontSize: '0.85rem'
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.3rem' }}>
                  {t('settings.energy.currency', 'Currency')}
                </label>
                <input
                  type="text"
                  maxLength={5}
                  value={formSettings.currency}
                  onChange={(e) => setFormSettings({ ...formSettings, currency: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-primary)',
                    fontSize: '0.85rem'
                  }}
                />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.3rem' }}>
                {t('settings.energy.allocation_method', 'Room Apportionment Method')}
              </label>
              <select
                value={formSettings.allocation_method}
                onChange={(e) => setFormSettings({ ...formSettings, allocation_method: e.target.value })}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontSize: '0.85rem'
                }}
              >
                <option value="demand">
                  {t('settings.energy.allocation_demand', 'Heat Demand Duty Cycle (Valve power × time)')}
                </option>
                <option value="area_weighted">
                  {t('settings.energy.allocation_area', 'Area-Weighted Demand (Valve power × time × room m²)')}
                </option>
              </select>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <Button type="button" variant="secondary" onClick={() => setShowConfigModal(false)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={isSaving}>
                {isSaving ? <Spinner size={16} /> : t('common.save', 'Save')}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Manual Reading Modal */}
      {showReadingModal && (
        <Modal
          isOpen={showReadingModal}
          onClose={() => setShowReadingModal(false)}
          title={t('settings.energy.record_reading', 'Log Manual Gas Meter Reading')}
        >
          <form onSubmit={handlePostReading} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.3rem' }}>
                {t('settings.energy.meter_reading', 'Current Meter Reading (m³)')}
              </label>
              <input
                type="number"
                step="0.001"
                required
                value={manualReading}
                onChange={(e) => setManualReading(e.target.value)}
                placeholder="e.g. 1542.840"
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontSize: '0.85rem'
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.3rem' }}>
                {t('settings.energy.unit_cost', 'Current Tariff / Unit Cost (optional)')}
              </label>
              <input
                type="number"
                step="0.0001"
                value={manualCost}
                onChange={(e) => setManualCost(e.target.value)}
                placeholder="Leave blank to use current setting"
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontSize: '0.85rem'
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <Button type="button" variant="secondary" onClick={() => setShowReadingModal(false)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={isSaving}>
                {isSaving ? <Spinner size={16} /> : t('common.submit', 'Submit')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

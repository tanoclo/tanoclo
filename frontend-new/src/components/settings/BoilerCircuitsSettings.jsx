/**
 * @file src/components/settings/BoilerCircuitsSettings.jsx
 * @brief Renders the low-level Boiler circuits telemetry and OT diagnostic panel.
 * 
 * Queries GraphQL endpoints for boiler manufacturers and model schemas, configures zone circuit drivers,
 * and displays real-time telemetry parameters (boiler return temperatures, flame modulations, boiler flow targets).
 */

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import Spinner from '../common/Spinner';
import Button from '../common/Button';
import Modal from '../common/Modal';
import { useHome } from '../../context/HomeContext';
import { getRawBoilerData, getCircuits } from '../../api/tanoclo';
import { Flame, RefreshCw, Settings, CheckCircle, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../api/client';
import logger from '../../utils/logger';
import { SWR_KEYS } from '../../utils/swrKeys';

/**
 * @brief Boiler and heating circuits configuration diagnostic dashboard panel.
 */
export default function BoilerCircuitsSettings() {
  const { t } = useTranslation();
  const { activeHomeId, _zones } = useHome();

  // Modal and GraphQL Search states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [manuSearchText, setManuSearchText] = useState('');
  const [modelSearchText, setModelSearchText] = useState('');
  const [manufacturers, setManufacturers] = useState([]);
  const [models, setModels] = useState([]);
  const [selectedManuId, setSelectedManuId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [loadingManus, setLoadingManus] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [isSavingModel, setIsSavingModel] = useState(false);

  // Fetch boiler telemetry
  const { data: boilerRaw, error: boilerErr, mutate: mutateBoiler } = useSWR(
    activeHomeId ? `/homes/${activeHomeId}/tanoclo/boiler/raw` : null,
    () => getRawBoilerData(activeHomeId),
    { refreshInterval: 5000 }
  );

  // Fetch circuits
  const { data: circuits, error: circErr, mutate: mutateCircuits } = useSWR(
    activeHomeId ? `/homes/${activeHomeId}/tanoclo/circuits` : null,
    () => getCircuits(activeHomeId)
  );

  // Fetch heating system details (boiler/underfloor presence)
  const { data: heatingSystem, mutate: mutateHeatingSystem } = useSWR(
    activeHomeId ? SWR_KEYS.heatingSystem(activeHomeId) : null,
    () => apiFetch(SWR_KEYS.heatingSystem(activeHomeId))
  );

  const boilerId = heatingSystem?.boiler?.id;

  // Fetch boiler model details from GraphQL using boiler id
  const { data: boilerDetails, mutate: mutateBoilerDetails } = useSWR(
    boilerId ? `/api/v2/graphql/system/${boilerId}` : null,
    () => apiFetch(`/api/v2/graphql`, {
      method: 'POST',
      body: {
        query: `query { system(id: ${boilerId}) { modelName manufacturers { name } } }`
      }
    })
  );

  const boilerInfo = boilerDetails?.data?.system;
  const manufacturerName = boilerInfo?.manufacturers?.[0]?.name || 'Generic';
  const modelName = boilerInfo?.modelName || 'OpenTherm Boiler';

  // Fetch Manufacturers list for search in Modal
  const fetchManufacturers = async (searchText) => {
    setLoadingManus(true);
    try {
      const res = await apiFetch(`/api/v2/graphql`, {
        method: 'POST',
        body: {
          query: `query { searchManufacturers(searchText: "${searchText || ''}") { manufacturers { id name } } }`
        }
      });
      setManufacturers(res?.data?.searchManufacturers?.manufacturers || []);
    } catch (err) {
      logger.error('Failed to fetch manufacturers:', err);
    } finally {
      setLoadingManus(false);
    }
  };

  // Fetch Boiler Models for selected manufacturer
  const fetchModels = async (manuId, searchText) => {
    if (!manuId) {
      setModels([]);
      return;
    }
    setLoadingModels(true);
    try {
      const res = await apiFetch(`/api/v2/graphql`, {
        method: 'POST',
        body: {
          query: `query { searchSystems(manufacturerIds: [${manuId}], searchText: "${searchText || ''}") { systems { id modelName manufacturers { name } } } }`
        }
      });
      setModels(res?.data?.searchSystems?.systems || []);
    } catch (err) {
      logger.error('Failed to fetch models:', err);
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (isModalOpen) {
      fetchManufacturers(manuSearchText);
    }
  }, [isModalOpen, manuSearchText]);

  useEffect(() => {
    if (selectedManuId) {
      fetchModels(selectedManuId, modelSearchText);
    } else {
      setModels(prev => prev.length ? [] : prev);
      setSelectedModelId(prev => prev ? '' : prev);
    }
  }, [selectedManuId, modelSearchText]);

  const handleToggleBoiler = async (e) => {
    const isPresent = e.target.checked;
    try {
      await apiFetch(SWR_KEYS.heatingSystem(activeHomeId), {
        method: 'PUT',
        body: {
          present: isPresent,
          found: heatingSystem?.boiler?.found ?? true,
          id: heatingSystem?.boiler?.id ?? null
        }
      });
      await Promise.all([
        mutateHeatingSystem(),
        mutateBoiler()
      ]);
    } catch (err) {
      logger.error('Failed to toggle boiler:', err);
    }
  };

  const handleToggleUnderfloor = async (e) => {
    const isPresent = e.target.checked;
    try {
      await apiFetch(SWR_KEYS.heatingSystem(activeHomeId), {
        method: 'PUT',
        body: {
          present: isPresent
        }
      });
      await mutateHeatingSystem();
    } catch (err) {
      logger.error('Failed to toggle underfloor heating:', err);
    }
  };

  const handleSaveBoilerModel = async () => {
    if (!selectedModelId) return;
    setIsSavingModel(true);
    try {
      await apiFetch(SWR_KEYS.heatingSystem(activeHomeId), {
        method: 'PUT',
        body: {
          present: true,
          found: true,
          id: parseInt(selectedModelId, 10)
        }
      });
      await Promise.all([
        mutateHeatingSystem(),
        mutateBoilerDetails()
      ]);
      setIsModalOpen(false);
    } catch (err) {
      logger.error('Failed to save boiler model:', err);
    } finally {
      setIsSavingModel(false);
    }
  };

  const handleRefresh = () => {
    mutateBoiler();
    mutateCircuits();
    mutateHeatingSystem();
    if (boilerId) mutateBoilerDetails();
  };

  // Helper: Renders an SVG Circular Gauge
  const renderCircularGauge = (value, min, max, label, unit, colorClass = 'var(--primary)', size = 110) => {
    const radius = size * 0.4;
    const strokeWidth = 8;
    const circumference = 2 * Math.PI * radius;
    const safeVal = Math.min(Math.max(value ?? min, min), max);
    const percentage = (safeVal - min) / (max - min);
    const strokeDashoffset = circumference - percentage * circumference;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
        <div style={{ position: 'relative', width: size, height: size }}>
          <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
            <circle 
              cx={size / 2} 
              cy={size / 2} 
              r={radius} 
              fill="transparent" 
              stroke="var(--border-color)" 
              strokeWidth={strokeWidth} 
            />
            <circle 
              cx={size / 2} 
              cy={size / 2} 
              r={radius} 
              fill="transparent" 
              stroke={colorClass} 
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset var(--transition-normal)' }}
            />
          </svg>
          <div style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.1rem',
            fontWeight: 800
          }}>
            <span>{value !== null && value !== undefined ? `${value}${unit}` : '--'}</span>
          </div>
        </div>
        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</span>
      </div>
    );
  };

  const formatBurnerHours = (val) => {
    if (val === null || val === undefined) return '--';
    const num = parseFloat(val);
    if (isNaN(num) || num >= 100000) return '--';
    return num.toFixed(1);
  };

  if (boilerErr || circErr) {
    return <div style={{ color: 'var(--danger)', padding: '1rem' }}>{t('settings.boiler_failed_load')}</div>;
  }

  if ((!boilerRaw && !boilerErr) || (!circuits && !circErr) || !heatingSystem) {
    return (
      <div style={{ padding: '3rem', textAlign: 'center' }}>
        <Spinner size={32} />
      </div>
    );
  }

  const faultFlags = boilerRaw?.field_0458;
  const hasFault = faultFlags !== null && faultFlags !== undefined && parseInt(faultFlags, 10) > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      
      {/* Title */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: '42px' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.boiler_circuits_title')}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
            {t('settings.boiler_circuits_desc')}
          </p>
        </div>
        <Button variant="secondary" onClick={handleRefresh} style={{ padding: '0.4rem 0.85rem' }}>
          <RefreshCw size={14} />
          <span>{t('common.refresh')}</span>
        </Button>
      </div>

      {/* Boiler & Underfloor Configuration */}
      <Card style={{ 
        display: 'flex', 
        flexDirection: 'column',
        gap: '1.25rem',
        padding: '1.25rem' 
      }}>
        <h3 style={{ margin: 0, fontSize: '1.0rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Settings size={18} style={{ color: 'var(--primary)' }} />
          {t('heating_activity.boiler_configuration')}
        </h3>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem' }}>
          {/* Boiler Switch */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                {t('heating_activity.boiler_enabled')}
              </span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {t('heating_activity.opentherm_desc', 'Configure OpenTherm boiler integration.')}
              </span>
            </div>
            
            <label className="switch" style={{
              position: 'relative',
              display: 'inline-block',
              width: '46px',
              height: '24px',
              cursor: 'pointer'
            }}>
              <input 
                type="checkbox" 
                checked={Boolean(heatingSystem?.boiler?.present)}
                onChange={handleToggleBoiler}
                style={{ opacity: 0, width: 0, height: 0 }} 
              />
              <span style={{
                position: 'absolute',
                top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: heatingSystem?.boiler?.present ? 'var(--primary)' : 'var(--bg-input)',
                borderRadius: '24px',
                border: '1px solid var(--border-color)',
                transition: '0.3s'
              }}>
                <span style={{
                  position: 'absolute',
                  content: '""',
                  height: '18px',
                  width: '18px',
                  left: heatingSystem?.boiler?.present ? '24px' : '3px',
                  bottom: '2px',
                  backgroundColor: '#fff',
                  borderRadius: '50%',
                  transition: '0.3s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.4)'
                }} />
              </span>
            </label>
          </div>

          {/* Underfloor Switch */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                {t('heating_activity.underfloor_heating_enabled')}
              </span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {t('heating_activity.underfloor_desc', 'Enable underfloor heating pump control.')}
              </span>
            </div>
            
            <label className="switch" style={{
              position: 'relative',
              display: 'inline-block',
              width: '46px',
              height: '24px',
              cursor: 'pointer'
            }}>
              <input 
                type="checkbox" 
                checked={Boolean(heatingSystem?.underfloorHeating?.present)}
                onChange={handleToggleUnderfloor}
                style={{ opacity: 0, width: 0, height: 0 }} 
              />
              <span style={{
                position: 'absolute',
                top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: heatingSystem?.underfloorHeating?.present ? 'var(--primary)' : 'var(--bg-input)',
                borderRadius: '24px',
                border: '1px solid var(--border-color)',
                transition: '0.3s'
              }}>
                <span style={{
                  position: 'absolute',
                  content: '""',
                  height: '18px',
                  width: '18px',
                  left: heatingSystem?.underfloorHeating?.present ? '24px' : '3px',
                  bottom: '2px',
                  backgroundColor: '#fff',
                  borderRadius: '50%',
                  transition: '0.3s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.4)'
                }} />
              </span>
            </label>
          </div>
        </div>

        {/* Change Boiler Option */}
        {Boolean(heatingSystem?.boiler?.present) && (
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center',
            borderTop: '1px solid var(--border-color)', 
            paddingTop: '1rem',
            flexWrap: 'wrap',
            gap: '0.75rem'
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                {t('heating_activity.boiler_model')}
              </span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {manufacturerName} • {modelName}
              </span>
            </div>
            <Button 
              variant="secondary" 
              onClick={() => setIsModalOpen(true)}
              style={{ padding: '0.4rem 0.85rem', fontSize: '0.85rem' }}
            >
              {t('heating_activity.change_boiler')}
            </Button>
          </div>
        )}
      </Card>

      {/* Boiler Status Card */}
      {Boolean(heatingSystem?.boiler?.present) && (
        hasFault ? (
          <Card style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between',
            gap: '1.25rem',
            padding: '1.25rem',
            border: '1px solid var(--danger)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flex: 1 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '48px',
                height: '48px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(239, 68, 68, 0.05) 100%)',
                border: '1px solid var(--danger)',
                color: 'var(--danger)'
              }}>
                <AlertTriangle size={28} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                  {t('heating_activity.boiler_status')}
                </span>
                <strong style={{ fontSize: '1.0rem', color: 'var(--danger)' }}>
                  {t('settings.system_fault', { code: '0x' + parseInt(faultFlags, 10).toString(16).toUpperCase() })}
                </strong>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  {manufacturerName} • {modelName}
                </span>
              </div>
            </div>
          </Card>
        ) : (
          <Card style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between',
            gap: '1.25rem',
            padding: '1.25rem' 
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flex: 1 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '48px',
                height: '48px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, rgba(76, 175, 80, 0.2) 0%, rgba(76, 175, 80, 0.05) 100%)',
                border: '1px solid var(--success)',
                color: 'var(--success)'
              }}>
                <CheckCircle size={28} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                  {t('heating_activity.boiler_status')}
                </span>
                <strong style={{ fontSize: '1.0rem', color: 'var(--text-primary)' }}>
                  {t('settings.system_normal')}
                </strong>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  {manufacturerName} • {modelName}
                </span>
              </div>
            </div>
          </Card>
        )
      )}

      {/* Burner State Header Card */}
      {Boolean(heatingSystem?.boiler?.present) && (
        <Card style={{ padding: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Flame size={20} style={{ color: boilerRaw.field_0457 ? 'var(--warning)' : 'var(--text-muted)' }} />
            <strong>{t('settings.boiler_burner_state')}</strong>
            <span style={{
              padding: '0.2rem 0.6rem',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: boilerRaw.field_0457 ? 'var(--warning-glow)' : 'var(--border-color)',
              color: boilerRaw.field_0457 ? 'var(--warning)' : 'var(--text-secondary)',
              fontSize: '0.75rem',
              fontWeight: 700
            }}>
              {boilerRaw.field_0457 ? t('tanoclo_ex.combustion_active') : t('tanoclo_ex.standby')}
            </span>
          </div>

          <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <div>
              <span>{t('settings.dhw_modulation')} </span>
              <strong style={{ color: 'var(--text-primary)' }}>
                {boilerRaw.field_046c ? t('common.supported') : t('common.not_supported')}
              </strong>
            </div>
          </div>
        </Card>
      )}

      {/* Circular Gauges */}
      {Boolean(heatingSystem?.boiler?.present) && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '1.5rem'
        }}>
          <Card style={{ padding: '1.25rem', display: 'flex', justifyContent: 'center' }}>
            {renderCircularGauge(
              boilerRaw.field_044c ? parseFloat(boilerRaw.field_044c) : null,
              20, 90, t('tanoclo_ex.ch_flow_temp'), '°', 'var(--warning)'
            )}
          </Card>
          <Card style={{ padding: '1.25rem', display: 'flex', justifyContent: 'center' }}>
            {renderCircularGauge(
              boilerRaw.field_044d ? parseFloat(boilerRaw.field_044d) : null,
              20, 90, t('tanoclo_ex.ch_return_temp'), '°', 'var(--info)'
            )}
          </Card>
          <Card style={{ padding: '1.25rem', display: 'flex', justifyContent: 'center' }}>
            {renderCircularGauge(
              boilerRaw.field_0450 ? parseFloat(boilerRaw.field_0450) : null,
              20, 80, t('tanoclo_ex.control_setpoint'), '°', 'var(--primary)'
            )}
          </Card>
          <Card style={{ padding: '1.25rem', display: 'flex', justifyContent: 'center' }}>
            {renderCircularGauge(
              boilerRaw.last_config_decoded?.['0x044e'] ? parseFloat(boilerRaw.last_config_decoded['0x044e']) : null,
              20, 150, t('tanoclo_ex.flue_exhaust_temp'), '°', 'hsl(0, 75%, 55%)'
            )}
          </Card>
          <Card style={{ padding: '1.25rem', display: 'flex', justifyContent: 'center' }}>
            {renderCircularGauge(
              boilerRaw.last_config_decoded?.['0x045a'] ? parseFloat(boilerRaw.last_config_decoded['0x045a']) : null,
              10, 70, t('tanoclo_ex.dhw_temperature'), '°', 'var(--secondary)'
            )}
          </Card>
          <Card style={{ padding: '1.25rem', display: 'flex', justifyContent: 'center' }}>
            {renderCircularGauge(
              boilerRaw.field_0452 ? parseInt(boilerRaw.field_0452, 10) : 0,
              0, 100, t('tanoclo_ex.relative_modulation'), '%', 'var(--warning)'
            )}
          </Card>
          <Card style={{ padding: '1.25rem', display: 'flex', justifyContent: 'center' }}>
            {renderCircularGauge(
              boilerRaw.field_0460 ? (boilerRaw.field_0460 & 0xffff) / 1000.0 : null,
              0, 4, t('tanoclo_ex.water_pressure'), ' bar', 
              (boilerRaw.field_0460 & 0xffff) / 1000.0 < 1.0 ? 'var(--danger)' : 'var(--secondary)'
            )}
          </Card>
        </div>
      )}

      {/* Stats and Counters split grid */}
      {Boolean(heatingSystem?.boiler?.present) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
          <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.openthem_cycles')}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.burner_ignition_starts')}</span>
                <strong>{boilerRaw.field_0463 !== null && boilerRaw.field_0463 !== undefined && parseInt(boilerRaw.field_0463, 10) !== 65535 ? `${boilerRaw.field_0463} cyc` : '--'}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.ch_pump_cycles')}</span>
                <strong>{boilerRaw.field_0464 !== null && boilerRaw.field_0464 !== undefined && parseInt(boilerRaw.field_0464, 10) !== 65535 ? `${boilerRaw.field_0464} cyc` : '--'}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.fault_flags_register')}</span>
                <strong style={{ fontFamily: 'monospace' }}>
                  0x{boilerRaw.field_0458 ? parseInt(boilerRaw.field_0458, 10).toString(16).toUpperCase() : '0000'}
                </strong>
              </div>
            </div>
          </Card>

          <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.boiler_lifetime_hours')}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.total_burner_hours')}</span>
                <strong>{formatBurnerHours(boilerRaw.field_0466)} hrs</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.ch_heating_duration')}</span>
                <strong>{formatBurnerHours(boilerRaw.field_0467)} hrs</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.dhw_sanitary_duration')}</span>
                <strong>{formatBurnerHours(boilerRaw.field_0468)} hrs</strong>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Circuits List section */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.5px' }}>
          {t('settings.heating_circuits_list')}
        </span>
        <Card style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: '650px', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-input)', borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '0.75rem 1rem' }}>{t('settings.circuit_no')}</th>
                <th style={{ padding: '0.75rem 1rem' }}>{t('settings.driver_serial')}</th>
                <th style={{ padding: '0.75rem 1rem' }}>{t('settings.reference_temp')}</th>
                <th style={{ padding: '0.75rem 1rem' }}>{t('settings.target_temp')}</th>
                <th style={{ padding: '0.75rem 1rem' }}>{t('settings.heat_demand')}</th>
                <th style={{ padding: '0.75rem 1rem' }}>{t('settings.operating_mode')}</th>
              </tr>
            </thead>
            <tbody>
              {circuits.map(circ => (
                <tr key={circ.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.75rem 1rem', fontWeight: 700 }}>{t('tanoclo_ex.circuit_label', { number: circ.number })}</td>
                  <td style={{ padding: '0.75rem 1rem' }}>
                    <span style={{ fontWeight: 600 }}>{circ.driver_serial_no || '--'}</span>
                  </td>
                  <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>
                    {circ.field_4040 !== null ? `${parseFloat(circ.field_4040).toFixed(1)}°C` : '--'}
                  </td>
                  <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>
                    {circ.field_4000 !== null ? `${parseFloat(circ.field_4000).toFixed(1)}°C` : '--'}
                  </td>
                  <td style={{ padding: '0.75rem 1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <div style={{
                        width: '3rem',
                        height: '0.5rem',
                        backgroundColor: 'var(--border-color)',
                        borderRadius: '2px',
                        overflow: 'hidden'
                      }}>
                        <div style={{
                          width: `${circ.field_4080 || 0}%`,
                          height: '100%',
                          backgroundColor: 'var(--warning)'
                        }} />
                      </div>
                      <strong>{circ.field_4080 || 0}%</strong>
                    </div>
                  </td>
                  <td style={{ padding: '0.75rem 1rem' }}>
                    <span style={{
                      padding: '0.15rem 0.5rem',
                      borderRadius: 'var(--radius-sm)',
                      backgroundColor: 'var(--border-color)',
                      fontSize: '0.75rem',
                      fontWeight: 600
                    }}>
                      {t('tanoclo_ex.mode_val', { mode: circ.field_2090 ?? '0' })}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {/* Boiler Selection Modal */}
      <Modal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        title={t('heating_activity.change_boiler')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          
          {/* Step 1: Select Manufacturer */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {t('heating_activity.select_manufacturer')}
            </label>
            
            <input 
              type="text"
              placeholder={t('heating_activity.search_manufacturer')}
              value={manuSearchText}
              onChange={(e) => setManuSearchText(e.target.value)}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600,
                marginBottom: '0.5rem'
              }}
            />
            
            <select
              value={selectedManuId}
              onChange={(e) => {
                setSelectedManuId(e.target.value);
                setSelectedModelId('');
              }}
              size={5}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.5rem',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
                fontWeight: 600,
                cursor: 'pointer',
                height: '120px'
              }}
            >
              <option value="">{t('heating_activity.select_manufacturer_placeholder', '-- Select Manufacturer --')}</option>
              {manufacturers.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            {loadingManus && <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('common.searching', 'Searching...')}</span>}
          </div>

          {/* Step 2: Select Model */}
          {selectedManuId && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                {t('heating_activity.select_model')}
              </label>
              
              <input 
                type="text"
                placeholder={t('heating_activity.search_model')}
                value={modelSearchText}
                onChange={(e) => setModelSearchText(e.target.value)}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.5rem 0.75rem',
                  borderRadius: 'var(--radius-sm)',
                  outline: 'none',
                  fontWeight: 600,
                  marginBottom: '0.5rem'
                }}
              />

              <select
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                size={5}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.5rem',
                  borderRadius: 'var(--radius-sm)',
                  outline: 'none',
                  fontWeight: 600,
                  cursor: 'pointer',
                  height: '120px'
                }}
              >
                <option value="">{t('heating_activity.select_model_placeholder', '-- Select Boiler Model --')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.modelName}</option>
                ))}
              </select>
              {loadingModels && <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('common.searching', 'Searching...')}</span>}
            </div>
          )}

          {/* Modal Actions */}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
            <Button type="button" variant="secondary" onClick={() => setIsModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button 
              type="button" 
              variant="primary" 
              onClick={handleSaveBoilerModel}
              disabled={isSavingModel || !selectedModelId}
            >
              <span>{isSavingModel ? t('settings.saving') : t('heating_activity.save_boiler_model')}</span>
            </Button>
          </div>
        </div>
      </Modal>

    </div>
  );
}

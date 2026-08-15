/**
 * @file src/components/settings/SettingsMenu.jsx
 * @brief Renders the settings sidebar menu grouping control panel categories.
 * 
 * Groups sub-settings (General, Control, Diagnostics) with visual icons, titles,
 * and descriptive headers matching local translation indexes.
 */


import { useTranslation } from 'react-i18next';
import {
  Settings, Home, Users, Shield, Thermometer, Calendar, Flame
} from 'lucide-react';

/**
 * @brief Generates the linear list of settings menu items.
 * @param {function} t - Translation handler.
 * @returns {Array} List of settings menu item configurations.
 */
export function getSettingsMenuItems(t) {
  return [
    { id: 'zones', label: t('settings.zones'), subtitle: t('settings.zones_desc'), icon: <Settings size={18} /> },
    { id: 'devices', label: t('settings.devices'), subtitle: t('settings.devices_desc'), icon: <Shield size={18} /> },
    { id: 'home-details', label: t('settings.home_details'), subtitle: t('settings.home_details_desc'), icon: <Home size={18} /> },
    { id: 'people', label: t('settings.people'), subtitle: t('settings.people_desc'), icon: <Users size={18} /> },
    { id: 'flow-temp', label: t('settings.flow_temp'), subtitle: t('settings.flow_temp_desc'), icon: <Thermometer size={18} /> },
    { id: 'smart-schedule', label: t('schedule.title'), subtitle: t('settings.schedule_desc'), icon: <Calendar size={18} /> },
    { id: 'heating-activity', label: t('heating_activity.title'), subtitle: t('settings.heating_activity_desc'), icon: <Flame size={18} /> },
    { id: 'boiler-circuits', label: t('settings.boiler_circuits'), subtitle: t('settings.boiler_circuits_desc'), icon: <Thermometer size={18} /> },
    { id: 'raw-explorer', label: t('settings.raw_explorer'), subtitle: t('settings.raw_explorer_desc'), icon: <Calendar size={18} /> }
  ];
}

export function getSettingsMenuGroups(t) {
  return [
    {
      title: t('settings.group_general', { defaultValue: 'General' }),
      items: [
        { id: 'home-details', label: t('settings.home_details'), subtitle: t('settings.home_details_desc'), icon: <Home size={18} /> },
        { id: 'people', label: t('settings.people'), subtitle: t('settings.people_desc'), icon: <Users size={18} /> }
      ]
    },
    {
      title: t('settings.group_control', { defaultValue: 'Control' }),
      items: [
        { id: 'zones', label: t('settings.zones'), subtitle: t('settings.zones_desc'), icon: <Settings size={18} /> },
        { id: 'devices', label: t('settings.devices'), subtitle: t('settings.devices_desc'), icon: <Shield size={18} /> },
        { id: 'flow-temp', label: t('settings.flow_temp'), subtitle: t('settings.flow_temp_desc'), icon: <Thermometer size={18} /> },
        { id: 'smart-schedule', label: t('schedule.title'), subtitle: t('settings.schedule_desc'), icon: <Calendar size={18} /> }
      ]
    },
    {
      title: t('settings.group_diagnostics', { defaultValue: 'Diagnostics' }),
      items: [
        { id: 'heating-activity', label: t('heating_activity.title'), subtitle: t('settings.heating_activity_desc'), icon: <Flame size={18} /> },
        { id: 'boiler-circuits', label: t('settings.boiler_circuits'), subtitle: t('settings.boiler_circuits_desc'), icon: <Thermometer size={18} /> },
        { id: 'raw-explorer', label: t('settings.raw_explorer'), subtitle: t('settings.raw_explorer_desc'), icon: <Calendar size={18} /> }
      ]
    }
  ];
}

/**
 * @brief Renders the settings sidebar navigation list.
 * @param {string} props.activeSection - Currently active configuration section code.
 * @param {function} props.onSelect - Section transition callback handler.
 */
export default function SettingsMenu({ activeSection, onSelect }) {
  const { t } = useTranslation();
  const groups = getSettingsMenuGroups(t);

  return (
    <aside style={{
      width: '100%',
      maxWidth: '280px',
      display: 'flex',
      flexDirection: 'column',
      gap: '1.25rem',
      paddingRight: '1rem',
      borderRight: '1px solid var(--border-color)'
    }}>
      {groups.map(group => (
        <div key={group.title} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <span style={{
            fontSize: '0.72rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            letterSpacing: '1px',
            paddingLeft: '0.85rem',
            marginBottom: '0.25rem'
          }}>
            {group.title}
          </span>
          {group.items.map(item => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelect(item.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.6rem 0.85rem',
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  backgroundColor: isActive ? 'var(--bg-card-hover)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: '0.85rem',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)'
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.02)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <div style={{
                  color: isActive ? 'var(--primary)' : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0
                }}>
                  {item.icon}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontWeight: isActive ? 600 : 500, color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    {item.label}
                  </span>
                  {item.subtitle && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.subtitle}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}


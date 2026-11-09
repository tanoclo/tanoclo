/**
 * @file src/components/schedule/SeasonProfileCard.jsx
 * @brief Renders a seasonal heating schedule profile card with rich visual themes.
 */

import { useTranslation } from 'react-i18next';
import {
  Snowflake,
  SunMedium,
  Sprout,
  Leaf,
  Check,
  Calendar,
  Camera,
  Settings2,
  Trash2,
  Home,
  Flame,
  ShieldCheck,
  Briefcase,
  Palmtree
} from 'lucide-react';
import Button from '../common/Button';

export const PROFILE_ICON_OPTIONS = [
  { id: 'calendar', label: 'Default / Calendar', emoji: '📅' },
  { id: 'home', label: 'Home', emoji: '🏠' },
  { id: 'summer', label: 'Summer', emoji: '☀️' },
  { id: 'autumn', label: 'Autumn', emoji: '🍂' },
  { id: 'winter', label: 'Winter', emoji: '❄️' },
  { id: 'spring', label: 'Spring', emoji: '🌱' },
  { id: 'flame', label: 'Comfort / Warm', emoji: '🔥' },
  { id: 'eco', label: 'Eco / Saver', emoji: '🔋' },
  { id: 'work', label: 'Work / Routine', emoji: '💼' },
  { id: 'holiday', label: 'Holiday / Trip', emoji: '🏖️' }
];

/**
 * Returns icon and color palette based on profile name or icon identifier.
 */
export function getSeasonTheme(icon, name = '') {
  const lowerName = (name || '').toLowerCase();
  const lowerIcon = (icon || '').toLowerCase();

  if (lowerIcon.includes('snow') || lowerName.includes('winter')) {
    return {
      icon: <Snowflake size={22} />,
      color: '#38bdf8',
      bgGlow: 'rgba(56, 189, 248, 0.15)',
      cardBg: 'linear-gradient(135deg, rgba(14, 165, 233, 0.18) 0%, rgba(2, 132, 199, 0.08) 100%)',
      borderColor: 'rgba(56, 189, 248, 0.35)',
      activeGlow: '0 0 20px rgba(56, 189, 248, 0.35)'
    };
  }

  if (lowerIcon.includes('summer') || lowerName.includes('summer')) {
    return {
      icon: <SunMedium size={22} />,
      color: '#f59e0b',
      bgGlow: 'rgba(245, 158, 11, 0.15)',
      cardBg: 'linear-gradient(135deg, rgba(245, 158, 11, 0.18) 0%, rgba(217, 119, 6, 0.08) 100%)',
      borderColor: 'rgba(245, 158, 11, 0.35)',
      activeGlow: '0 0 20px rgba(245, 158, 11, 0.35)'
    };
  }

  if (lowerIcon.includes('holiday') || lowerName.includes('holiday') || lowerIcon.includes('palmtree')) {
    return {
      icon: <Palmtree size={22} />,
      color: '#facc15',
      bgGlow: 'rgba(250, 204, 21, 0.15)',
      cardBg: 'linear-gradient(135deg, rgba(234, 179, 8, 0.18) 0%, rgba(202, 138, 4, 0.08) 100%)',
      borderColor: 'rgba(250, 204, 21, 0.35)',
      activeGlow: '0 0 20px rgba(250, 204, 21, 0.35)'
    };
  }

  if (lowerIcon.includes('sprout') || lowerName.includes('spring')) {
    return {
      icon: <Sprout size={22} />,
      color: '#4ade80',
      bgGlow: 'rgba(74, 222, 128, 0.15)',
      cardBg: 'linear-gradient(135deg, rgba(34, 197, 94, 0.18) 0%, rgba(22, 163, 74, 0.08) 100%)',
      borderColor: 'rgba(74, 222, 128, 0.35)',
      activeGlow: '0 0 20px rgba(74, 222, 128, 0.35)'
    };
  }

  if (lowerIcon.includes('leaf') || lowerIcon.includes('autumn') || lowerName.includes('autumn')) {
    return {
      icon: <Leaf size={22} />,
      color: '#fb923c',
      bgGlow: 'rgba(251, 146, 60, 0.15)',
      cardBg: 'linear-gradient(135deg, rgba(234, 88, 12, 0.18) 0%, rgba(180, 83, 9, 0.08) 100%)',
      borderColor: 'rgba(251, 146, 60, 0.35)',
      activeGlow: '0 0 20px rgba(251, 146, 60, 0.35)'
    };
  }

  if (lowerIcon.includes('flame') || lowerIcon.includes('comfort') || lowerName.includes('comfort')) {
    return {
      icon: <Flame size={22} />,
      color: '#f43f5e',
      bgGlow: 'rgba(244, 63, 94, 0.15)',
      cardBg: 'linear-gradient(135deg, rgba(244, 63, 94, 0.18) 0%, rgba(225, 29, 72, 0.08) 100%)',
      borderColor: 'rgba(244, 63, 94, 0.35)',
      activeGlow: '0 0 20px rgba(244, 63, 94, 0.35)'
    };
  }

  if (lowerIcon.includes('eco') || lowerName.includes('eco') || lowerName.includes('saving')) {
    return {
      icon: <ShieldCheck size={22} />,
      color: '#10b981',
      bgGlow: 'rgba(16, 185, 129, 0.15)',
      cardBg: 'linear-gradient(135deg, rgba(16, 185, 129, 0.18) 0%, rgba(5, 150, 105, 0.08) 100%)',
      borderColor: 'rgba(16, 185, 129, 0.35)',
      activeGlow: '0 0 20px rgba(16, 185, 129, 0.35)'
    };
  }

  if (lowerIcon.includes('work') || lowerIcon.includes('briefcase') || lowerName.includes('work')) {
    return {
      icon: <Briefcase size={22} />,
      color: '#8b5cf6',
      bgGlow: 'rgba(139, 92, 246, 0.15)',
      cardBg: 'linear-gradient(135deg, rgba(139, 92, 246, 0.18) 0%, rgba(109, 40, 217, 0.08) 100%)',
      borderColor: 'rgba(139, 92, 246, 0.35)',
      activeGlow: '0 0 20px rgba(139, 92, 246, 0.35)'
    };
  }

  if (lowerIcon.includes('home') || lowerName.includes('home')) {
    return {
      icon: <Home size={22} />,
      color: '#6366f1',
      bgGlow: 'rgba(99, 102, 241, 0.15)',
      cardBg: 'linear-gradient(135deg, rgba(99, 102, 241, 0.18) 0%, rgba(79, 70, 229, 0.08) 100%)',
      borderColor: 'rgba(99, 102, 241, 0.35)',
      activeGlow: '0 0 20px rgba(99, 102, 241, 0.35)'
    };
  }

  // Default / Calendar neutral theme (not seasonal)
  return {
    icon: <Calendar size={22} />,
    color: '#3b82f6',
    bgGlow: 'rgba(59, 130, 246, 0.15)',
    cardBg: 'linear-gradient(135deg, rgba(59, 130, 246, 0.18) 0%, rgba(29, 78, 216, 0.08) 100%)',
    borderColor: 'rgba(59, 130, 246, 0.35)',
    activeGlow: '0 0 20px rgba(59, 130, 246, 0.35)'
  };
}

/**
 * Format 'MM-DD' into readable localized month/day (e.g. 'Sep 21')
 */
export function formatMonthDay(mmDdStr) {
  if (!mmDdStr) return '';
  const [m, d] = mmDdStr.split('-').map(Number);
  if (!m || !d) return mmDdStr;
  const date = new Date(2026, m - 1, d);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function SeasonProfileCard({
  profile,
  isActive = false,
  isActivating = false,
  onActivate,
  onCapture,
  onEdit,
  onDelete,
  compact = false
}) {
  const { t } = useTranslation();
  const theme = getSeasonTheme(profile.icon, profile.name);

  const startDateStr = profile.autoStartDate ? formatMonthDay(profile.autoStartDate) : null;

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => onActivate && onActivate(profile)}
        disabled={isActivating}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          padding: '12px 8px',
          borderRadius: 'var(--radius-md)',
          background: isActive ? theme.cardBg : 'var(--bg-card)',
          border: `1.5px solid ${isActive ? theme.borderColor : 'var(--border-color)'}`,
          boxShadow: isActive ? theme.activeGlow : 'none',
          color: 'var(--text-primary)',
          cursor: 'pointer',
          transition: 'all var(--transition-fast)',
          position: 'relative',
          flex: '1 1 0',
          minWidth: '70px',
          outline: 'none'
        }}
      >
        <div style={{
          color: theme.color,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '36px',
          height: '36px',
          borderRadius: '50%',
          backgroundColor: theme.bgGlow,
          transition: 'transform var(--transition-fast)'
        }}>
          {theme.icon}
        </div>
        <span style={{
          fontSize: '0.8rem',
          fontWeight: isActive ? 700 : 500,
          color: isActive ? theme.color : 'var(--text-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%'
        }}>
          {profile.name}
        </span>
        {isActive && (
          <span style={{
            position: 'absolute',
            top: '6px',
            right: '6px',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: theme.color,
            boxShadow: `0 0 8px ${theme.color}`
          }} />
        )}
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        borderRadius: 'var(--radius-lg)',
        background: theme.cardBg,
        border: `1.5px solid ${isActive ? theme.borderColor : 'var(--border-color)'}`,
        boxShadow: isActive ? theme.activeGlow : 'var(--glass-shadow)',
        backdropFilter: 'blur(var(--glass-blur))',
        padding: '1.25rem',
        gap: '1rem',
        transition: 'all var(--transition-normal)'
      }}
    >
      {/* Top Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{
            color: theme.color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            backgroundColor: theme.bgGlow,
            flexShrink: 0
          }}>
            {theme.icon}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {profile.name}
              </h3>
              {isActive && (
                <span style={{
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  backgroundColor: theme.bgGlow,
                  color: theme.color,
                  border: `1px solid ${theme.borderColor}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}>
                  <Check size={10} /> {t('schedule.profile_active', 'Active')}
                </span>
              )}
            </div>
            {profile.description && (
              <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {profile.description}
              </p>
            )}
          </div>
        </div>

        {/* Action icons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {onEdit && (
            <Button
              variant="secondary"
              onClick={() => onEdit(profile)}
              style={{ width: '32px', height: '32px', padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              title={t('common.edit', 'Edit')}
            >
              <Settings2 size={15} />
            </Button>
          )}
          {onDelete && !isActive && (
            <Button
              variant="secondary"
              onClick={() => onDelete(profile)}
              style={{ width: '32px', height: '32px', padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)' }}
              title={t('common.delete', 'Delete')}
            >
              <Trash2 size={15} />
            </Button>
          )}
        </div>
      </div>

      {/* Start Date & Zones Count Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        {startDateStr ? (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
            backgroundColor: 'var(--bg-card)',
            padding: '4px 10px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-color)'
          }}>
            <Calendar size={13} style={{ color: theme.color }} />
            <span>{t('schedule.starts_on', { date: startDateStr, defaultValue: `Starts on ${startDateStr}` })}</span>
          </div>
        ) : (
          <div style={{
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
            backgroundColor: 'var(--bg-card)',
            padding: '4px 10px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-color)'
          }}>
            {t('schedule.manual_switch_only', 'Manual switch only')}
          </div>
        )}

        {profile.zonesCount > 0 && (
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {profile.zonesCount} {t('schedule.zones_configured', 'rooms configured')}
          </span>
        )}
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '4px' }}>
        <Button
          variant={isActive ? "secondary" : "primary"}
          disabled={isActive || isActivating}
          onClick={() => onActivate && onActivate(profile)}
          style={{ flex: 1, height: '38px', fontWeight: 600 }}
        >
          {isActive
            ? t('schedule.currently_active', 'Active Schedule')
            : t('schedule.activate_profile', 'One tap switch')}
        </Button>

        {onCapture && (
          <Button
            variant="secondary"
            onClick={() => onCapture(profile)}
            title={t('schedule.capture_tooltip', 'Capture all rooms currently active timetable into this profile')}
            style={{ height: '38px', padding: '0 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Camera size={14} />
            <span style={{ fontSize: '0.8rem' }}>{t('schedule.capture', 'Capture')}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * @file src/components/schedule/DaySelector.jsx
 * @brief Renders the timetable structure configuration picker.
 * 
 * Exposes a segmented control allowing the user to select between 3 calendar layout schemes:
 * 1-day block (same schedule Mon-Sun), 3-day blocks (Mon-Fri, Sat, Sun), or 7-day blocks (independent Mon-Sun).
 */


import SegmentedControl from '../common/SegmentedControl';
import { useTranslation } from 'react-i18next';

/**
 * @brief Day selector component.
 * @param {number} props.value - Active schedule layout code (0: 1-day, 1: 3-day, 2: 7-day).
 * @param {function} props.onChange - Switch callback hook.
 */
export default function DaySelector({ value, onChange }) {
  const { t } = useTranslation();

  const options = [
    { label: t('schedule.one_day'), value: 0 },
    { label: t('schedule.three_day'), value: 1 },
    { label: t('schedule.seven_day'), value: 2 }
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
      <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
        {t('schedule.timetable_type')}
      </span>
      <SegmentedControl 
        options={options}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

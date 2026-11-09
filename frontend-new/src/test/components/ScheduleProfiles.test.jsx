/**
 * @file src/test/components/ScheduleProfiles.test.jsx
 * @brief Unit tests for SeasonProfileCard and season profile theming.
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import SeasonProfileCard, { getSeasonTheme, formatMonthDay } from '../../components/schedule/SeasonProfileCard';

describe('SeasonProfileCard theming & utilities', () => {
  it('resolves correct themes based on profile names', () => {
    const winter = getSeasonTheme('snowflake', 'Winter');
    expect(winter.color).toBe('#38bdf8');

    const holiday = getSeasonTheme('sun', 'Holiday');
    expect(holiday.color).toBe('#facc15');

    const spring = getSeasonTheme('sprout', 'Spring');
    expect(spring.color).toBe('#4ade80');

    const autumn = getSeasonTheme('leaf', 'Autumn');
    expect(autumn.color).toBe('#fb923c');
  });

  it('formats month-day strings correctly', () => {
    expect(formatMonthDay('09-21')).toContain('21');
    expect(formatMonthDay('12-20')).toContain('20');
  });

  it('renders compact profile button markup', () => {
    const profile = { id: 1, name: 'Winter', icon: 'snowflake', isActive: false };
    const html = renderToString(
      <SeasonProfileCard
        profile={profile}
        compact
        isActive={false}
      />
    );
    expect(html).toContain('Winter');
  });

  it('renders full profile card with active status and date range', () => {
    const profile = {
      id: 2,
      name: 'Autumn',
      icon: 'leaf',
      description: 'Moderate temperatures',
      autoStartDate: '09-21',
      autoEndDate: '12-20',
      zonesCount: 4,
      isActive: true
    };

    const html = renderToString(
      <SeasonProfileCard
        profile={profile}
        isActive={true}
      />
    );
    expect(html).toContain('Autumn');
    expect(html).toContain('Moderate temperatures');
  });
});

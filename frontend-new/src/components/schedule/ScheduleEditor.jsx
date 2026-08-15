/**
 * @file src/components/schedule/ScheduleEditor.jsx
 * @brief Renders the smart schedule editor panel.
 * 
 * Exposes two sub-tabs: "Schedule" (interactive 24h timeline charts, copy-paste block capabilities,
 * timezone offsets, delete/split blocks modals, and copy-schedule-to-other-rooms tools) and
 * "Away" (setting parameters like ECO/COMFORT preheating curves and minimum away temperatures).
 */

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'react-i18next';
import { useHome } from '../../context/HomeContext';
import { getTimetableBlocks, updateDayBlocks, copySchedule, getActiveTimetable, setActiveTimetable } from '../../api/zones';
import DaySelector from './DaySelector';
import DayTimeline from './DayTimeline';
import Modal from '../common/Modal';
import Button from '../common/Button';
import Toggle from '../common/Toggle';
import Slider from '../common/Slider';
import Card from '../common/Card';
import Spinner from '../common/Spinner';
import { Copy, Clipboard, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { apiFetch } from '../../api/client';
import logger from '../../utils/logger';
import { useToast } from '../../context/ToastContext';
import { SWR_KEYS } from '../../utils/swrKeys';

/**
 * @brief Helper to resolve visual background colors for time blocks based on setpoints.
 * @param {object} block - Target time block details.
 * @param {boolean} isDhw - Whether the zone is Domestic Hot Water.
 * @returns {string} Calculated HSL color string.
 */
const getBlockColor = (block, isDhw) => {
  if (block.setting?.power === 'OFF') return 'var(--text-muted)';
  if (isDhw) {
    const temp = block.setting?.temperature?.celsius ?? 50.0;
    const ratio = Math.min(1, Math.max(0, (temp - 30.0) / 35.0));
    const hue = 200 - ratio * 175;
    return `hsl(${hue}, 75%, 45%)`;
  }
  const temp = block.setting?.temperature?.celsius ?? 15.0;
  const ratio = Math.min(1, Math.max(0, (temp - 5.0) / 20.0));
  const hue = 200 - ratio * 175;
  return `hsl(${hue}, 75%, 45%)`;
};

/**
 * @brief Renders the smart schedule dashboard view.
 * @param {number} props.zoneId - Active zone identifier.
 */
export default function ScheduleEditor({ zoneId }) {
  const { t } = useTranslation();
  const { activeHomeId, zones } = useHome();
  const zone = zones?.find(z => z.id === zoneId);
  const isDhw = zone?.type === 'HOT_WATER' || zone?.type === 'DHW';
  const otherZones = zones?.filter(z => z.id !== zoneId) || [];

  const { showToast } = useToast();
  const [activeTimetableId, setActiveTimetableId] = useState(0); // 0 = 1 day, 1 = 3 day, 2 = 7 day
  const [blocksData, setBlocksData] = useState([]); // Array of all blocks for this timetable

  // Copy paste buffer
  const [copyBuffer, setCopyBuffer] = useState(null);

  // Copy schedule to other zones state
  const [isCopyModalOpen, setIsCopyModalOpen] = useState(false);
  const [selectedZones, setSelectedZones] = useState({});
  const [isCopying, setIsCopying] = useState(false);

  const handleCopyScheduleToZones = async () => {
    const targetZoneIds = Object.keys(selectedZones)
      .filter(id => selectedZones[id])
      .map(Number);

    if (targetZoneIds.length === 0) {
      showToast(t('schedule.select_target_zones_error', 'Please select at least one zone'), 'error');
      return;
    }

    setIsCopying(true);
    try {
      await copySchedule(activeHomeId, zoneId, targetZoneIds);
      showToast(t('schedule.copy_success'), 'success');
      setIsCopyModalOpen(false);
      setSelectedZones({});
    } catch (err) {
      logger.error('Failed to copy schedule:', err);
      showToast(t('schedule.copy_failed', 'Failed to copy schedule'), 'error');
    } finally {
      setIsCopying(false);
    }
  };


  // Modal edit states
  const [editingBlock, setEditingBlock] = useState(null);
  const [editingIndex, setEditingIndex] = useState(-1);
  const [editingDayType, setEditingDayType] = useState('');
  const [editTemp, setEditTemp] = useState(20.0);
  const [editPower, setEditPower] = useState('ON');
  const [editStart, setEditStart] = useState('00:00');
  const [editEnd, setEditEnd] = useState('24:00');

  // Collapsed days state
  const [collapsedDays, setCollapsedDays] = useState({});

  // Sub-tab state
  const [activeSubTab, setActiveSubTab] = useState('schedule'); // 'schedule' | 'away'

  // Away Configuration states
  const [_awayConfig, setAwayConfig] = useState(null);
  const [awayLoading, setAwayLoading] = useState(false);
  const [awaySaving, setAwaySaving] = useState(false);
  const [autoAdjust, setAutoAdjust] = useState(true);
  const [preheatingLevel, setPreheatingLevel] = useState('MEDIUM'); // ECO, BALANCE, COMFORT
  const [minAwayTemp, setMinAwayTemp] = useState(15.0);
  const [dhwAwayPower, setDhwAwayPower] = useState('OFF');
  const [dhwAwayTemp, setDhwAwayTemp] = useState(50.0);

  // SWR fetch active timetable
  const { data: activeTt, mutate: mutateActiveTt } = useSWR(
    activeHomeId && (zoneId !== null && zoneId !== undefined) ? SWR_KEYS.activeTimetable(activeHomeId, zoneId) : null,
    () => getActiveTimetable(activeHomeId, zoneId)
  );

  // Sync active timetable state when SWR loads
  useEffect(() => {
    if (activeTt && activeTt.id) {
      setActiveTimetableId(prev => prev !== activeTt.id ? activeTt.id : prev);
    }
  }, [activeTt]);

  // SWR fetch all blocks for the active timetable
  const { data: fetchedBlocks, error: _fetchError, mutate: mutateBlocks } = useSWR(
    activeHomeId && (zoneId !== null && zoneId !== undefined) && activeTimetableId !== null 
      ? SWR_KEYS.timetableBlocks(activeHomeId, zoneId, activeTimetableId)
      : null,
    () => getTimetableBlocks(activeHomeId, zoneId, activeTimetableId)
  );

  // Sync fetched blocks data locally
  useEffect(() => {
    if (fetchedBlocks) {
      const sanitized = fetchedBlocks.map(block => {
        let end = block.end;
        if (block.start === block.end || block.end === '00:00') {
          end = '24:00';
        }
        
        let setting = { ...block.setting };
        if (isDhw) {
          setting.type = 'HOT_WATER';
          // Ensure temperature is set to a default if power is ON but temperature is missing
          if (setting.power === 'ON' && !setting.temperature) {
            setting.temperature = { celsius: 50.0 };
          }
        }
        
        return {
          ...block,
          end,
          setting
        };
      });
      setBlocksData(sanitized);
    }
  }, [fetchedBlocks, isDhw]);

  // Away config fetch effect
  useEffect(() => {
    if (activeSubTab === 'away' && activeHomeId && (zoneId !== null && zoneId !== undefined)) {
      setAwayLoading(prev => prev ? prev : true);
      apiFetch(`/api/v2/homes/${activeHomeId}/zones/${zoneId}/awayConfiguration`)
        .then(data => {
          setAwayConfig(data);
          if (data.type === 'HEATING') {
            setAutoAdjust(data.autoAdjust ?? true);
            setPreheatingLevel(data.preheatingLevel || 'MEDIUM');
            setMinAwayTemp(data.minimumAwayTemperature?.celsius ?? 15.0);
          } else {
            setAutoAdjust(false);
            if (isDhw) {
              setDhwAwayPower(data.setting?.power || 'OFF');
              setDhwAwayTemp(data.setting?.temperature?.celsius ?? 50.0);
            } else {
              setDhwAwayPower(data.setting?.power || 'OFF');
              setMinAwayTemp(data.setting?.temperature?.celsius ?? 15.0);
            }
          }
        })
        .catch(err => {
          logger.error('Failed to load away config:', err);
        })
        .finally(() => {
          setAwayLoading(false);
        });
    }
  }, [activeSubTab, activeHomeId, zoneId, isDhw]);

  const handleSaveAwayConfig = async () => {
    setAwaySaving(true);
    try {
      const payload = {};
      if (isDhw) {
        payload.type = 'FIXED_SETTING';
        payload.setting = {
          type: 'HOT_WATER',
          power: dhwAwayPower,
          temperature: dhwAwayPower === 'OFF' ? null : { celsius: dhwAwayTemp }
        };
      } else {
        if (autoAdjust) {
          payload.type = 'HEATING';
          payload.autoAdjust = true;
          payload.preheatingLevel = preheatingLevel;
          payload.minimumAwayTemperature = { celsius: minAwayTemp, fahrenheit: parseFloat((minAwayTemp * 1.8 + 32).toFixed(1)) };
        } else {
          payload.type = 'FIXED_SETTING';
          payload.setting = {
            type: 'HEATING',
            power: minAwayTemp <= 5.0 ? 'OFF' : 'ON',
            temperature: minAwayTemp <= 5.0 ? null : { celsius: minAwayTemp, fahrenheit: parseFloat((minAwayTemp * 1.8 + 32).toFixed(1)) }
          };
        }
      }
      
      await apiFetch(`/api/v2/homes/${activeHomeId}/zones/${zoneId}/awayConfiguration`, {
        method: 'PUT',
        body: payload
      });
      showToast(t('schedule.away_saved_success'), 'success');
    } catch (err) {
      logger.error('Failed to save away config:', err);
      showToast(t('schedule.away_saved_failed'), 'error');
    } finally {
      setAwaySaving(false);
    }
  };

  const handleTimetableTypeChange = async (newId) => {
    setActiveTimetableId(newId);
    try {
      await setActiveTimetable(activeHomeId, zoneId, newId);
      mutateActiveTt();
      mutateBlocks();
    } catch (_err) {
      showToast(t('schedule.timetable_switch_failed'), 'error');
    }
  };

  // Groups blocks by dayType (e.g. MONDAY_TO_FRIDAY vs SATURDAY)
  const getDayTypesForTimetable = () => {
    if (activeTimetableId === 0) return ['MONDAY_TO_SUNDAY'];
    if (activeTimetableId === 1) return ['MONDAY_TO_FRIDAY', 'SATURDAY', 'SUNDAY'];
    return ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
  };

  const dayTypes = getDayTypesForTimetable();

  const getBlocksForDay = (dayType) => {
    return blocksData.filter(b => b.dayType === dayType);
  };

  // Open Edit Block Modal
  const handleBlockClick = (block, idx, dayType) => {
    setEditingBlock(block);
    setEditingIndex(idx);
    setEditingDayType(dayType);
    setEditStart(block.start);
    setEditEnd(block.end || '24:00');
    setEditPower(block.setting?.power || 'ON');
    setEditTemp(block.setting?.temperature?.celsius ?? (isDhw ? 50.0 : 20.0));
  };

  // Save Block Edit
  const handleSaveBlockEdit = async () => {
    const dayBlocks = [...getBlocksForDay(editingDayType)].sort((a, b) => a.start.localeCompare(b.start));
    const current = dayBlocks[editingIndex];

    const timeToMinutes = (tStr) => {
      const [h, m] = tStr.split(':').map(Number);
      return h * 60 + m;
    };

    const startMin = timeToMinutes(editStart);
    const endMin = timeToMinutes(editEnd);

    if (startMin >= endMin) {
      showToast(t('schedule.start_time_before_end_time'), "error");
      return;
    }

    if (editingIndex > 0) {
      const prevBlock = dayBlocks[editingIndex - 1];
      const prevStartMin = timeToMinutes(prevBlock.start);
      if (startMin <= prevStartMin) {
        showToast(t('schedule.start_time_after_prev_block', { start: prevBlock.start }), "error");
        return;
      }
    }

    if (editingIndex < dayBlocks.length - 1) {
      const nextBlock = dayBlocks[editingIndex + 1];
      const nextEndMin = timeToMinutes(nextBlock.end || '24:00');
      if (endMin >= nextEndMin) {
        showToast(t('schedule.end_time_before_next_block', { end: nextBlock.end || '24:00' }), "error");
        return;
      }
    }

    // Build the updated block
    const updated = {
      ...current,
      start: editStart,
      end: editEnd,
      setting: {
        type: isDhw ? 'HOT_WATER' : 'HEATING',
        power: editPower,
        temperature: (isDhw && editPower === 'OFF') ? null : { celsius: editTemp }
      }
    };

    // Update in the local array
    dayBlocks[editingIndex] = updated;

    // Standardize contiguous logic:
    // If end time changed, ensure it meets next block start
    if (editingIndex < dayBlocks.length - 1 && editEnd !== current.end) {
      dayBlocks[editingIndex + 1].start = editEnd;
    }
    // If start time changed, ensure it meets previous block end
    if (editingIndex > 0 && editStart !== current.start) {
      dayBlocks[editingIndex - 1].end = editStart;
    }

    // Sort and save to backend
    await saveDayBlocks(editingDayType, dayBlocks);
    setEditingBlock(null);
  };

  // Split and Add Block
  const handleAddBlock = async (dayType) => {
    const dayBlocks = [...getBlocksForDay(dayType)].sort((a, b) => a.start.localeCompare(b.start));
    if (dayBlocks.length === 0) return;

    // Find the largest block to split
    let targetIdx = 0;
    let maxDuration = 0;
    
    dayBlocks.forEach((b, idx) => {
      const startMin = timeToMinutes(b.start);
      let endMin = timeToMinutes(b.end);
      if (endMin <= startMin) endMin = 1440;
      const dur = endMin - startMin;
      if (dur > maxDuration) {
        maxDuration = dur;
        targetIdx = idx;
      }
    });

    const targetBlock = dayBlocks[targetIdx];
    const startMin = timeToMinutes(targetBlock.start);
    let endMin = timeToMinutes(targetBlock.end);
    if (endMin <= startMin) endMin = 1440;

    const splitMin = startMin + Math.floor((endMin - startMin) / 2);
    const splitTimeStr = minutesToTimeStr(splitMin);

    // Create the split
    const oldEnd = targetBlock.end;
    targetBlock.end = splitTimeStr;

    const newBlock = {
      dayType,
      start: splitTimeStr,
      end: oldEnd,
      geolocationOverride: false,
      setting: {
        type: isDhw ? 'HOT_WATER' : 'HEATING',
        power: 'ON',
        temperature: isDhw ? { celsius: 50.0 } : { celsius: 20.0 }
      }
    };

    dayBlocks.splice(targetIdx + 1, 0, newBlock);
    await saveDayBlocks(dayType, dayBlocks);
  };

  // Delete Block (merge with previous or next)
  const handleDeleteBlock = async () => {
    const dayBlocks = [...getBlocksForDay(editingDayType)].sort((a, b) => a.start.localeCompare(b.start));
    if (dayBlocks.length <= 1) {
      showToast(t('schedule.cannot_delete_only_block'), 'warning');
      return;
    }

    if (editingIndex === 0) {
      // Merge with next block (expand next block start to 00:00)
      dayBlocks[1].start = '00:00';
    } else {
      // Merge with previous block (expand previous block end to this block's end)
      dayBlocks[editingIndex - 1].end = dayBlocks[editingIndex].end;
    }

    dayBlocks.splice(editingIndex, 1);
    await saveDayBlocks(editingDayType, dayBlocks);
    setEditingBlock(null);
  };

  // Save Day Blocks list to Backend API
  const saveDayBlocks = async (dayType, newDayBlocks) => {
    try {
      const response = await updateDayBlocks(activeHomeId, zoneId, activeTimetableId, dayType, newDayBlocks);
      // Replace only this day's blocks in local state
      setBlocksData(prev => [
        ...prev.filter(b => b.dayType !== dayType),
        ...response
      ]);
      showToast(t('schedule.schedule_saved_success'), 'success');
    } catch (_err) {
      showToast(t('schedule.schedule_saved_failed'), 'error');
    }
  };

  // Copy schedule day to clipboard
  const handleCopyDay = (dayType) => {
    const dayBlocks = getBlocksForDay(dayType);
    setCopyBuffer({ blocks: dayBlocks });
    showToast(t('schedule.day_copied_success'), 'success');
  };

  // Paste schedule day from clipboard
  const handlePasteDay = async (dayType) => {
    if (!copyBuffer) return;
    const pastedBlocks = copyBuffer.blocks.map(b => ({
      ...b,
      dayType: dayType
    }));
    await saveDayBlocks(dayType, pastedBlocks);
    showToast(t('schedule.day_pasted_success'), 'success');
  };

  // Helper conversions
  const timeToMinutes = (timeStr) => {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  };

  const minutesToTimeStr = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const toggleCollapsed = (day) => {
    setCollapsedDays(prev => ({
      ...prev,
      [day]: !prev[day]
    }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%' }}>
      
      {/* Sub-tab selection */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', width: '100%', marginBottom: '0.5rem' }}>
        <div style={{
          display: 'flex',
          backgroundColor: 'var(--bg-input)',
          padding: '3px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-color)',
          width: '100%',
          maxWidth: '300px'
        }}>
          <button
            onClick={() => setActiveSubTab('schedule')}
            style={{
              flex: 1,
              padding: '0.4rem 0.8rem',
              borderRadius: 'calc(var(--radius-md) - 4px)',
              border: 'none',
              backgroundColor: activeSubTab === 'schedule' ? 'var(--bg-card-hover)' : 'transparent',
              color: activeSubTab === 'schedule' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
              transition: 'all 0.15s'
            }}
          >
            {t('schedule.title')}
          </button>
          <button
            onClick={() => setActiveSubTab('away')}
            style={{
              flex: 1,
              padding: '0.4rem 0.8rem',
              borderRadius: 'calc(var(--radius-md) - 4px)',
              border: 'none',
              backgroundColor: activeSubTab === 'away' ? 'var(--bg-card-hover)' : 'transparent',
              color: activeSubTab === 'away' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
              transition: 'all 0.15s'
            }}
          >
            {t('schedule.away_settings')}
          </button>
        </div>

        {activeSubTab === 'schedule' && otherZones.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => {
              const initial = {};
              otherZones.forEach(z => {
                initial[z.id] = false;
              });
              setSelectedZones(initial);
              setIsCopyModalOpen(true);
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
          >
            <Copy size={14} />
            <span>{t('schedule.copy_schedule')}</span>
          </Button>
        )}
      </div>


      {activeSubTab === 'schedule' ? (
        <>
          {/* Timetable Mode Selector */}
          <DaySelector 
            value={activeTimetableId}
            onChange={handleTimetableTypeChange}
          />

      {/* Timelines list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {dayTypes.map((dt) => {
          const blocks = getBlocksForDay(dt);
          const isCollapsed = collapsedDays[dt];

          return (
            <div 
              key={dt}
              className="glass-panel"
              style={{
                padding: '1rem',
                border: '1px solid var(--border-color)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                borderRadius: 'var(--radius-md)'
              }}
            >
              {/* Timeline Header Row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <button
                  onClick={() => toggleCollapsed(dt)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    color: 'var(--text-primary)'
                  }}
                >
                  {isCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                  <span>{t('schedule.day_types.' + dt, { defaultValue: dt.replace(/_/g, ' ') })}</span>
                </button>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {/* Add Block */}
                  <button 
                    onClick={() => handleAddBlock(dt)}
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color)',
                      backgroundColor: 'var(--bg-card-hover)',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      color: 'var(--text-primary)'
                    }}
                  >
                    <Plus size={12} />
                    <span>{t('common.add')}</span>
                  </button>
                  
                  {/* Copy */}
                  <button 
                    onClick={() => handleCopyDay(dt)}
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color)',
                      backgroundColor: 'var(--bg-card-hover)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      color: 'var(--text-secondary)'
                    }}
                    title={t('schedule.copy_day')}
                  >
                    <Copy size={12} />
                  </button>

                  {/* Paste */}
                  {copyBuffer && (
                    <button 
                      onClick={() => handlePasteDay(dt)}
                      style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        border: '1px solid var(--primary)',
                        backgroundColor: 'var(--primary-glow)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        color: 'var(--primary-light)'
                      }}
                      title={t('schedule.paste_day')}
                    >
                      <Clipboard size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* Timeline Horizontal Bar */}
              {!isCollapsed && (
                <div style={{ marginTop: '0.25rem' }}>
                  <DayTimeline 
                    dayType={dt}
                    blocks={blocks}
                    isDhw={isDhw}
                    onBlockClick={(block, idx) => handleBlockClick(block, idx, dt)}
                  />

                  {/* Detailed Interactive Block Cards */}
                  <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.6rem',
                    marginTop: '0.75rem',
                    padding: '0.25rem 0'
                  }}>
                    {blocks.map((block, idx) => {
                      const isPowerOn = block.setting?.power !== 'OFF';
                      const label = isDhw 
                        ? (isPowerOn 
                            ? (block.setting?.temperature?.celsius ? `${block.setting.temperature.celsius.toFixed(0)}°C` : 'ON')
                            : t('common.off'))
                        : (isPowerOn
                            ? `${block.setting?.temperature?.celsius?.toFixed(1)}°C`
                            : t('common.off'));
                      
                      const blockColor = getBlockColor(block, isDhw);

                      return (
                        <div 
                          key={`${block.start}-${idx}`}
                          onClick={() => handleBlockClick(block, idx, dt)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.5rem 0.85rem',
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--border-color)',
                            borderLeft: `4px solid ${blockColor}`,
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                            fontSize: '0.825rem',
                            transition: 'all var(--transition-fast)',
                            boxShadow: 'var(--glass-shadow)',
                            userSelect: 'none'
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'var(--bg-card-hover)';
                            e.currentTarget.style.transform = 'translateY(-1px)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'var(--bg-card)';
                            e.currentTarget.style.transform = 'translateY(0)';
                          }}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left' }}>
                            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                              {block.start} - {block.end}
                            </span>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                              {label}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Edit Block Modal */}
      {editingBlock && (
        <Modal 
          isOpen={editingBlock !== null} 
          onClose={() => setEditingBlock(null)}
          title={t('schedule.edit_block')}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            
            {/* Time Adjust Steppers */}
            <div style={{ display: 'flex', gap: '1rem', width: '100%' }}>
              <div className="form-group" style={{ flex: 1 }}>
                <span className="form-label">{t('schedule.start_time')}</span>
                <input 
                  type="time" 
                  className="form-input"
                  value={editStart}
                  onChange={(e) => setEditStart(e.target.value)}
                  disabled={editingIndex === 0} // First block must start at 00:00
                />
              </div>

              <div className="form-group" style={{ flex: 1 }}>
                <span className="form-label">{t('schedule.end_time')}</span>
                <input 
                  type="time" 
                  className="form-input"
                  value={editEnd}
                  onChange={(e) => setEditEnd(e.target.value)}
                  disabled={editingIndex === getBlocksForDay(editingDayType).length - 1} // Last block must end at 24:00/00:00
                />
              </div>
            </div>

            {/* Power (DHW only) */}
            {isDhw && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                  {t('schedule.hot_water_output')}
                </span>
                <Toggle 
                  checked={editPower === 'ON'} 
                  onChange={(checked) => setEditPower(checked ? 'ON' : 'OFF')}
                  label={editPower}
                />
              </div>
            )}

            {/* Setpoint (Heating or DHW ON) */}
            {(!isDhw || editPower === 'ON') && (
              <div style={{ width: '100%' }}>
                <Slider 
                  min={isDhw ? 30.0 : 5.0} 
                  max={isDhw ? 65.0 : 25.0} 
                  step={isDhw ? 1.0 : 0.5} 
                  value={editTemp} 
                  onChange={setEditTemp} 
                  label={isDhw ? t('schedule.target_hw_temp') : t('zone_detail.target_temp')} 
                  unit="°C"
                />
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', width: '100%' }}>
              <Button 
                variant="destructive"
                onClick={handleDeleteBlock}
                disabled={getBlocksForDay(editingDayType).length <= 1}
                style={{ flexShrink: 0 }}
              >
                <Trash2 size={16} />
              </Button>
              <Button 
                variant="secondary"
                onClick={() => setEditingBlock(null)}
                style={{ flex: 1 }}
              >
                {t('common.cancel')}
              </Button>
              <Button 
                variant="primary"
                onClick={handleSaveBlockEdit}
                style={{ flex: 1 }}
              >
                {t('common.save')}
              </Button>
            </div>

          </div>
        </Modal>
      )}
        </>
      ) : (
        /* Render Away Settings Card */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '600px' }}>
          {awayLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
              <Spinner size={24} />
            </div>
          ) : (
            <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>{t('schedule.away_mode_config')}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '-0.5rem' }}>
                {t('schedule.away_mode_desc')}
              </p>

              {isDhw ? (
                /* DHW Away Settings */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong>{t('schedule.hot_water_output')}</strong>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                        {t('schedule.dhw_away_desc')}
                      </p>
                    </div>
                    <Toggle 
                      checked={dhwAwayPower === 'ON'} 
                      onChange={(checked) => setDhwAwayPower(checked ? 'ON' : 'OFF')}
                      label={dhwAwayPower}
                    />
                  </div>

                  {dhwAwayPower === 'ON' && (
                    <div style={{ padding: '0.5rem 0' }}>
                      <Slider 
                        min={30.0} 
                        max={65.0} 
                        step={1.0} 
                        value={dhwAwayTemp} 
                        onChange={setDhwAwayTemp} 
                        label={t('schedule.target_hw_temp')} 
                        unit="°C"
                      />
                    </div>
                  )}
                </div>
              ) : (
                /* Heating Away Settings */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong>{t('schedule.auto_adjust_smart_away')}</strong>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                        {t('schedule.auto_adjust_desc')}
                      </p>
                    </div>
                    <Toggle 
                      checked={autoAdjust} 
                      onChange={setAutoAdjust} 
                    />
                  </div>

                  {autoAdjust ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
                      {/* Preheating Comfort level */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('schedule.preheating_comfort_level')}</span>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          {['ECO', 'BALANCE', 'COMFORT'].map((level) => (
                            <button
                              key={level}
                              onClick={() => setPreheatingLevel(level)}
                              style={{
                                flex: 1,
                                padding: '0.4rem 0.8rem',
                                border: '1px solid var(--border-color)',
                                backgroundColor: preheatingLevel === level ? 'var(--primary-glow)' : 'transparent',
                                color: preheatingLevel === level ? 'var(--primary-light)' : 'var(--text-secondary)',
                                fontWeight: 600,
                                fontSize: '0.8rem',
                                borderRadius: 'var(--radius-sm)',
                                cursor: 'pointer',
                                transition: 'all 0.15s'
                              }}
                            >
                              {level === 'ECO' ? t('schedule.comfort_eco') : level === 'BALANCE' ? t('schedule.comfort_balance') : t('schedule.comfort_comfort')}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Minimum Away Temperature slider */}
                      <div style={{ padding: '0.5rem 0' }}>
                        <Slider 
                          min={5.0} 
                          max={25.0} 
                          step={0.5} 
                          value={minAwayTemp} 
                          onChange={setMinAwayTemp} 
                          label={t('schedule.min_away_temp')} 
                          unit="°C"
                        />
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
                      <div style={{ padding: '0.5rem 0' }}>
                        <Slider 
                          min={5.0} 
                          max={25.0} 
                          step={0.5} 
                          value={minAwayTemp} 
                          onChange={setMinAwayTemp} 
                          label={t('schedule.fixed_away_temp')} 
                          unit="°C"
                        />
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                          {t('schedule.fixed_away_desc')}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <Button 
                variant="primary" 
                onClick={handleSaveAwayConfig}
                disabled={awaySaving}
                style={{ width: '100%', padding: '0.75rem', marginTop: '0.5rem' }}
              >
                {awaySaving ? t('settings.saving') : t('settings.save_settings')}
              </Button>
            </Card>
          )}
        </div>
      )}

      {/* Copy Schedule Modal */}
      {isCopyModalOpen && (
        <Modal
          isOpen={isCopyModalOpen}
          onClose={() => setIsCopyModalOpen(false)}
          title={t('schedule.copy_schedule')}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
              {t('schedule.copy_schedule_desc', 'Select target zones to copy this smart schedule to:')}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '200px', overflowY: 'auto' }}>
              {/* Select All */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', padding: '0.5rem', borderRadius: '4px', backgroundColor: 'var(--bg-input)' }}>
                <input
                  type="checkbox"
                  checked={otherZones.length > 0 && otherZones.every(z => selectedZones[z.id])}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    const updated = {};
                    otherZones.forEach(z => {
                      updated[z.id] = checked;
                    });
                    setSelectedZones(updated);
                  }}
                  style={{ cursor: 'pointer' }}
                />
                <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{t('common.select_all', 'Select All')}</span>
              </label>

              {/* Individual Zones */}
              {otherZones.map(z => (
                <label key={z.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(selectedZones[z.id])}
                    onChange={(e) => {
                      setSelectedZones(prev => ({
                        ...prev,
                        [z.id]: e.target.checked
                      }));
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{z.name}</span>
                </label>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <Button
                variant="secondary"
                onClick={() => setIsCopyModalOpen(false)}
                disabled={isCopying}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={handleCopyScheduleToZones}
                disabled={isCopying || !Object.values(selectedZones).some(Boolean)}
              >
                {isCopying ? t('common.loading') : t('common.save')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

    </div>
  );
}

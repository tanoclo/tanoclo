/**
 * @file src/components/settings/ScheduleSettings.jsx
 * @brief Renders the Heating Schedule Profiles manager and Zone Schedule picker list.
 */

import { useState } from 'react';
import useSWR from 'swr';
import { ArrowLeft, Calendar, Plus, Sliders, Layers } from 'lucide-react';
import Button from '../common/Button';
import Card from '../common/Card';
import ListItem from '../common/ListItem';
import Modal from '../common/Modal';
import ConfirmModal from '../common/ConfirmModal';
import SegmentedControl from '../common/SegmentedControl';
import ScheduleEditor from '../schedule/ScheduleEditor';
import SeasonProfileCard, { PROFILE_ICON_OPTIONS } from '../schedule/SeasonProfileCard';
import { useHome } from '../../context/HomeContext';
import { useToast } from '../../context/ToastContext';
import { SWR_KEYS } from '../../utils/swrKeys';
import {
  getScheduleProfiles,
  activateScheduleProfile,
  createScheduleProfile,
  updateScheduleProfile,
  deleteScheduleProfile,
  captureScheduleProfile
} from '../../api/scheduleProfiles';
import logger from '../../utils/logger';

export default function ScheduleSettings({
  zones,
  scheduleZoneId,
  handleBack,
  searchParams,
  setSearchParams,
  t
}) {
  const { activeHomeId } = useHome();
  const { showToast } = useToast();

  // Default page is Individual Rooms per user requirement
  const [activeSubTab, setActiveSubTab] = useState('rooms'); // 'rooms' | 'profiles'
  const [activatingId, setActivatingId] = useState(null);

  // Modal states
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isCaptureModalOpen, setIsCaptureModalOpen] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState(null);

  // Form states
  const [formData, setFormData] = useState({
    name: '',
    icon: 'calendar',
    description: '',
    autoStartDate: '',
    isAutoEnabled: false
  });

  const { data: profilesData, mutate: mutateProfiles } = useSWR(
    activeHomeId ? SWR_KEYS.scheduleProfiles(activeHomeId) : null,
    () => getScheduleProfiles(activeHomeId),
    { revalidateOnFocus: false }
  );

  // If a specific zone is selected for schedule editing, show ScheduleEditor
  if (scheduleZoneId !== null && scheduleZoneId !== undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minHeight: '42px' }}>
          <Button variant="secondary" onClick={handleBack} style={{ width: '32px', height: '32px', padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <ArrowLeft size={16} />
          </Button>
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>
              {zones?.find(z => z.id === scheduleZoneId)?.name} {t('schedule.title', 'Schedule')}
            </h2>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block' }}>
              {t('settings.configure_timetable_desc', 'Configure time blocks and target temperatures')}
            </span>
          </div>
        </div>
        <ScheduleEditor zoneId={scheduleZoneId} />
      </div>
    );
  }

  const profiles = profilesData?.profiles || [];
  const activeProfileId = profilesData?.activeProfileId;

  const handleActivate = async (profile) => {
    if (profile.id === activeProfileId) return;

    setActivatingId(profile.id);
    try {
      await activateScheduleProfile(activeHomeId, profile.id);
      showToast(t('schedule.switched_to_profile', {
        name: profile.name,
        defaultValue: `Switched all room schedules to ${profile.name}`
      }), 'success');
      mutateProfiles({
        ...profilesData,
        activeProfileId: profile.id,
        profiles: profiles.map(p => ({
          ...p,
          isActive: p.id === profile.id
        }))
      }, { revalidate: true });
    } catch (err) {
      logger.error('Failed to activate profile:', err);
      showToast(t('schedule.switch_failed', 'Failed to switch schedule profile'), 'error');
    } finally {
      setActivatingId(null);
    }
  };

  const handleOpenEdit = (profile) => {
    setSelectedProfile(profile);
    setFormData({
      name: profile.name,
      icon: profile.icon || 'calendar',
      description: profile.description || '',
      autoStartDate: profile.autoStartDate || '',
      isAutoEnabled: Boolean(profile.autoStartDate)
    });
    setIsEditModalOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!selectedProfile || !formData.name) return;
    try {
      await updateScheduleProfile(activeHomeId, selectedProfile.id, {
        name: formData.name,
        icon: formData.icon,
        description: formData.description,
        autoStartDate: (formData.isAutoEnabled && formData.autoStartDate) ? formData.autoStartDate.trim() : null
      });
      showToast(t('common.saved', 'Saved successfully'), 'success');
      setIsEditModalOpen(false);
      mutateProfiles();
    } catch (err) {
      logger.error('Failed to update profile:', err);
      showToast(t('common.save_failed', 'Failed to save changes'), 'error');
    }
  };

  const handleOpenCreate = () => {
    setFormData({
      name: '',
      icon: 'calendar',
      description: '',
      autoStartDate: '',
      isAutoEnabled: false
    });
    setIsCreateModalOpen(true);
  };

  const handleSaveCreate = async () => {
    if (!formData.name) return;
    try {
      await createScheduleProfile(activeHomeId, {
        name: formData.name,
        icon: formData.icon,
        description: formData.description,
        autoStartDate: (formData.isAutoEnabled && formData.autoStartDate) ? formData.autoStartDate.trim() : null
      });
      showToast(t('schedule.profile_created', 'Schedule profile created'), 'success');
      setIsCreateModalOpen(false);
      mutateProfiles();
    } catch (err) {
      logger.error('Failed to create profile:', err);
      showToast(t('schedule.create_failed', 'Failed to create profile'), 'error');
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedProfile) return;
    try {
      await deleteScheduleProfile(activeHomeId, selectedProfile.id);
      showToast(t('schedule.profile_deleted', 'Profile deleted'), 'success');
      setIsDeleteModalOpen(false);
      setSelectedProfile(null);
      mutateProfiles();
    } catch (err) {
      logger.error('Failed to delete profile:', err);
      showToast(err.message || t('common.delete_failed', 'Failed to delete'), 'error');
    }
  };

  const handleConfirmCapture = async () => {
    if (!selectedProfile) return;
    try {
      await captureScheduleProfile(activeHomeId, selectedProfile.id);
      showToast(t('schedule.capture_success', {
        name: selectedProfile.name,
        defaultValue: `Current room schedules captured into ${selectedProfile.name}`
      }), 'success');
      setIsCaptureModalOpen(false);
      setSelectedProfile(null);
      mutateProfiles();
    } catch (err) {
      logger.error('Failed to capture schedules:', err);
      showToast(t('schedule.capture_failed', 'Failed to capture schedules'), 'error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      {/* Title & Description */}
      <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>
          {t('schedule.title', 'Heating Schedule')}
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '4px 0 0 0' }}>
          {t('schedule.manage_desc', 'Configure individual room schedules or switch presets with schedule profiles')}
        </p>
      </div>

      {/* Sub-tab switcher: Individual Rooms (default) vs Schedule Profiles */}
      <SegmentedControl
        value={activeSubTab}
        onChange={setActiveSubTab}
        options={[
          {
            value: 'rooms',
            label: t('schedule.tab_rooms', 'Individual Rooms'),
            icon: <Sliders size={16} />
          },
          {
            value: 'profiles',
            label: t('schedule.tab_profiles', 'Schedule Profiles'),
            icon: <Layers size={16} />
          }
        ]}
      />

      {/* Individual Rooms Sub-tab (Default) */}
      {activeSubTab === 'rooms' && (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {zones?.map(zone => (
            <ListItem
              key={zone.id}
              icon={<Calendar size={18} style={{ color: 'var(--primary)' }} />}
              title={zone.name}
              subtitle={t('settings.configure_timetable_desc', 'Configure time blocks and target temperatures')}
              onClick={() => {
                const nextParams = new URLSearchParams(searchParams);
                nextParams.set('scheduleZoneId', zone.id);
                setSearchParams(nextParams);
              }}
            />
          ))}
        </Card>
      )}

      {/* Schedule Profiles Sub-tab */}
      {activeSubTab === 'profiles' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Schedule Profiles Grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '1rem'
          }}>
            {profiles.map(profile => (
              <SeasonProfileCard
                key={profile.id}
                profile={profile}
                isActive={profile.id === activeProfileId || profile.isActive}
                isActivating={activatingId === profile.id}
                onActivate={handleActivate}
                onCapture={(p) => {
                  setSelectedProfile(p);
                  setIsCaptureModalOpen(true);
                }}
                onEdit={handleOpenEdit}
                onDelete={(p) => {
                  setSelectedProfile(p);
                  setIsDeleteModalOpen(true);
                }}
              />
            ))}
          </div>

          {/* Add Profile Button */}
          <Button
            variant="secondary"
            onClick={handleOpenCreate}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: '42px' }}
          >
            <Plus size={16} />
            <span>{t('schedule.add_custom_profile', 'Create schedule profile')}</span>
          </Button>
        </div>
      )}

      {/* Create Profile Modal */}
      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        title={t('schedule.create_profile_title', 'Create Schedule Profile')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
              {t('common.name', 'Profile Name')}
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g. Standard, Summer, Vacation"
              style={{
                width: '100%',
                padding: '0.6rem 0.8rem',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                fontSize: '0.9rem'
              }}
            />
          </div>

          <div>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
              {t('schedule.icon_type', 'Theme / Icon')}
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '6px' }}>
              {PROFILE_ICON_OPTIONS.map(opt => (
                <button
                  type="button"
                  key={opt.id}
                  onClick={() => setFormData({ ...formData, icon: opt.id })}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: `1.5px solid ${formData.icon === opt.id ? 'var(--primary)' : 'var(--border-color)'}`,
                    backgroundColor: formData.icon === opt.id ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-input)',
                    color: 'var(--text-primary)',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)'
                  }}
                >
                  <span style={{ fontSize: '1rem' }}>{opt.emoji}</span>
                  <span style={{ fontWeight: formData.icon === opt.id ? 600 : 400 }}>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
              {t('common.description', 'Description')}
            </label>
            <input
              type="text"
              value={formData.description}
              onChange={e => setFormData({ ...formData, description: e.target.value })}
              placeholder="e.g. Daytime comfort heating"
              style={{
                width: '100%',
                padding: '0.6rem 0.8rem',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                fontSize: '0.9rem'
              }}
            />
          </div>

          {/* Date Auto-activation settings */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            padding: '12px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-color)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                id="createAutoDateToggle"
                checked={formData.isAutoEnabled}
                onChange={e => setFormData({ ...formData, isAutoEnabled: e.target.checked })}
                style={{ width: '16px', height: '16px', cursor: 'pointer' }}
              />
              <label htmlFor="createAutoDateToggle" style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                {t('schedule.enable_auto_date', 'Auto-activate on calendar date')}
              </label>
            </div>

            {formData.isAutoEnabled ? (
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                  {t('schedule.auto_start_date_label', 'Start Date (MM-DD)')}
                </label>
                <input
                  type="text"
                  value={formData.autoStartDate}
                  onChange={e => setFormData({ ...formData, autoStartDate: e.target.value })}
                  placeholder="e.g. 11-01 (Nov 1st)"
                  style={{
                    width: '100%',
                    padding: '0.6rem 0.8rem',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-primary)',
                    fontSize: '0.9rem'
                  }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
                  {t('schedule.auto_start_help', 'Automatically switches to this profile when this date arrives.')}
                </span>
              </div>
            ) : (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {t('schedule.manual_only_help', 'Manual only — only activates when you switch to it.')}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
            <Button variant="secondary" onClick={() => setIsCreateModalOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="primary" onClick={handleSaveCreate} disabled={!formData.name}>
              {t('common.save', 'Save')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit Profile Modal */}
      <Modal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        title={t('schedule.edit_profile_title', 'Edit Schedule Profile')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
              {t('common.name', 'Profile Name')}
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              style={{
                width: '100%',
                padding: '0.6rem 0.8rem',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                fontSize: '0.9rem'
              }}
            />
          </div>

          <div>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
              {t('schedule.icon_type', 'Theme / Icon')}
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '6px' }}>
              {PROFILE_ICON_OPTIONS.map(opt => (
                <button
                  type="button"
                  key={opt.id}
                  onClick={() => setFormData({ ...formData, icon: opt.id })}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: `1.5px solid ${formData.icon === opt.id ? 'var(--primary)' : 'var(--border-color)'}`,
                    backgroundColor: formData.icon === opt.id ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-input)',
                    color: 'var(--text-primary)',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)'
                  }}
                >
                  <span style={{ fontSize: '1rem' }}>{opt.emoji}</span>
                  <span style={{ fontWeight: formData.icon === opt.id ? 600 : 400 }}>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
              {t('common.description', 'Description')}
            </label>
            <input
              type="text"
              value={formData.description}
              onChange={e => setFormData({ ...formData, description: e.target.value })}
              style={{
                width: '100%',
                padding: '0.6rem 0.8rem',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                fontSize: '0.9rem'
              }}
            />
          </div>

          {/* Date Auto-activation settings */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            padding: '12px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-color)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                id="editAutoDateToggle"
                checked={formData.isAutoEnabled}
                onChange={e => setFormData({ ...formData, isAutoEnabled: e.target.checked })}
                style={{ width: '16px', height: '16px', cursor: 'pointer' }}
              />
              <label htmlFor="editAutoDateToggle" style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                {t('schedule.enable_auto_date', 'Auto-activate on calendar date')}
              </label>
            </div>

            {formData.isAutoEnabled ? (
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                  {t('schedule.auto_start_date_label', 'Start Date (MM-DD)')}
                </label>
                <input
                  type="text"
                  value={formData.autoStartDate}
                  onChange={e => setFormData({ ...formData, autoStartDate: e.target.value })}
                  placeholder="e.g. 11-01 (Nov 1st)"
                  style={{
                    width: '100%',
                    padding: '0.6rem 0.8rem',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-primary)',
                    fontSize: '0.9rem'
                  }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
                  {t('schedule.auto_start_help', 'Automatically switches to this profile when this date arrives.')}
                </span>
              </div>
            ) : (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {t('schedule.manual_only_help', 'Manual only — only activates when you switch to it.')}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
            <Button variant="secondary" onClick={() => setIsEditModalOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="primary" onClick={handleSaveEdit} disabled={!formData.name}>
              {t('common.save', 'Save')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={handleConfirmDelete}
        title={t('schedule.delete_profile_title', 'Delete Profile')}
        message={t('schedule.delete_profile_confirm', {
          name: selectedProfile?.name,
          defaultValue: `Are you sure you want to delete profile "${selectedProfile?.name}"?`
        })}
        confirmLabel={t('common.delete', 'Delete')}
        variant="danger"
      />

      {/* Capture Confirmation Modal */}
      <ConfirmModal
        isOpen={isCaptureModalOpen}
        onClose={() => setIsCaptureModalOpen(false)}
        onConfirm={handleConfirmCapture}
        title={t('schedule.capture_title', 'Capture Current Schedules')}
        message={t('schedule.capture_confirm', {
          name: selectedProfile?.name,
          defaultValue: `Overwrite schedule blocks in "${selectedProfile?.name}" with all rooms currently active schedules?`
        })}
        confirmLabel={t('schedule.capture', 'Capture')}
        variant="primary"
      />
    </div>
  );
}
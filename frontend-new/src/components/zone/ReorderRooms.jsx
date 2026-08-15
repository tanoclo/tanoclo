/**
 * @file src/components/zone/ReorderRooms.jsx
 * @brief Renders the modal dialog for room sorting/reordering.
 * 
 * Synchronizes list arrays locally, exposes up/down arrows to change array indexes,
 * and pushes the new order representation list to backend APIs.
 */

import { useState, useEffect } from 'react';
import Modal from '../common/Modal';
import Button from '../common/Button';
import { useHome } from '../../context/HomeContext';
import { updateZoneOrder } from '../../api/homes';
import { ArrowUp, ArrowDown, Move } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import logger from '../../utils/logger';

/**
 * @brief Room reordering Modal component.
 * @param {boolean} props.isOpen - Whether the modal dialog overlay is visible.
 * @param {function} props.onClose - Modal close event callback hook.
 */
export default function ReorderRooms({ isOpen, onClose }) {
  const { t } = useTranslation();
  const { activeHomeId, zones, mutateZones, mutateZoneStates } = useHome();
  const [localZones, setLocalZones] = useState([]);
  const [isSaving, setIsSaving] = useState(false);

  // Sync with home context zones when modal opens
  useEffect(() => {
    if (zones && isOpen) {
      setLocalZones([...zones]);
    }
  }, [zones, isOpen]);

  if (!zones) return null;

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const reordered = [...localZones];
    const temp = reordered[index];
    reordered[index] = reordered[index - 1];
    reordered[index - 1] = temp;
    setLocalZones(reordered);
  };

  const handleMoveDown = (index) => {
    if (index === localZones.length - 1) return;
    const reordered = [...localZones];
    const temp = reordered[index];
    reordered[index] = reordered[index + 1];
    reordered[index + 1] = temp;
    setLocalZones(reordered);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const zoneIds = localZones.map(z => z.id);
      await updateZoneOrder(activeHomeId, zoneIds);
      
      // Refresh home state in cache
      await Promise.all([mutateZones(), mutateZoneStates()]);
      onClose();
    } catch (err) {
      logger.error('Failed to update room order:', err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('dashboard.zones.reorder')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        
        {/* Reorder List */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--bg-input)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden'
        }}>
          {localZones.map((z, idx) => (
            <div 
              key={z.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.875rem 1.25rem',
                borderBottom: idx === localZones.length - 1 ? 'none' : '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-card)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Move size={16} style={{ color: 'var(--text-muted)' }} />
                <span style={{ fontWeight: 500 }}>{z.name}</span>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {/* Move Up */}
                <button
                  onClick={() => handleMoveUp(idx)}
                  disabled={idx === 0}
                  style={{
                    padding: '6px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-card-hover)',
                    cursor: idx === 0 ? 'not-allowed' : 'pointer',
                    opacity: idx === 0 ? 0.3 : 1,
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <ArrowUp size={16} />
                </button>

                {/* Move Down */}
                <button
                  onClick={() => handleMoveDown(idx)}
                  disabled={idx === localZones.length - 1}
                  style={{
                    padding: '6px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-card-hover)',
                    cursor: idx === localZones.length - 1 ? 'not-allowed' : 'pointer',
                    opacity: idx === localZones.length - 1 ? 0.3 : 1,
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <ArrowDown size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
          <Button 
            variant="secondary" 
            onClick={onClose} 
            disabled={isSaving}
            style={{ flex: 1 }}
          >
            {t('common.cancel')}
          </Button>
          <Button 
            variant="primary" 
            onClick={handleSave} 
            disabled={isSaving}
            style={{ flex: 1 }}
          >
            {isSaving ? t('dashboard.zones.saving_order') : t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

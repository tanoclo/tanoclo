/**
 * @file src/components/settings/DeviceNeighborsTable.jsx
 * @brief Renders the IB neighbor routing table on the Internet Bridge device settings page.
 *
 * Displays neighbor IPv6 entries reported by the IB on bootup, matches them against registered home devices,
 * provides full ListItem navigation to matched devices, allows unassociating unknown neighbor IPs,
 * and highlights registered devices missing from the IB neighbor routing table.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import Card from '../common/Card';
import ListItem from '../common/ListItem';
import Button from '../common/Button';
import ConfirmModal from '../common/ConfirmModal';
import { Network, AlertTriangle, Trash2, HelpCircle, Smartphone } from 'lucide-react';
import { unassociateNeighbor } from '../../api/devices';
import { useToast } from '../../context/ToastContext';
import { useTranslation } from 'react-i18next';

/**
 * Normalizes an IPv6 string to a full 8-group 16-bit hex string for canonical comparison.
 * @param {string} ip 
 * @returns {string|null}
 */
function normalizeIpv6(ip) {
  if (!ip || typeof ip !== 'string') return null;
  let cleanIp = ip.toLowerCase().trim();
  if (cleanIp.startsWith('0x')) cleanIp = cleanIp.slice(2);

  // Handle raw hex string containing sub-TLV header (e.g. 01d210fe80...)
  const fe80Idx = cleanIp.indexOf('fe80');
  if (fe80Idx >= 0 && cleanIp.length >= fe80Idx + 32) {
    const rawHex32 = cleanIp.slice(fe80Idx, fe80Idx + 32);
    const groups = [];
    for (let i = 0; i < 32; i += 4) {
      groups.push(rawHex32.slice(i, i + 4));
    }
    return groups.join(':');
  }

  // If uncompressed hex representation of 16 bytes (32 hex chars)
  if (/^[0-9a-f]{32}$/.test(cleanIp)) {
    const groups = [];
    for (let i = 0; i < 32; i += 4) {
      groups.push(cleanIp.slice(i, i + 4));
    }
    cleanIp = groups.join(':');
  }

  let parts = cleanIp.split(':');
  if (cleanIp.includes('::')) {
    const [left, right] = cleanIp.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - (leftParts.length + rightParts.length);
    const middle = new Array(Math.max(0, missing)).fill('0');
    parts = [...leftParts, ...middle, ...rightParts];
  }

  if (parts.length !== 8) return cleanIp;
  return parts.map(p => p.padStart(4, '0')).join(':');
}

export default function DeviceNeighborsTable({
  homeId,
  ibDeviceId,
  neighborData,
  allDevices = [],
  onSelectDevice,
  isReadOnly = false,
  mutateDevice
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [unassociateTargetIp, setUnassociateTargetIp] = useState(null);
  const [isUnassociating, setIsUnassociating] = useState(false);

  const neighborsList = Array.isArray(neighborData?.neighbors) ? neighborData.neighbors : [];
  const updatedAtStr = neighborData?.updated_at
    ? new Date(neighborData.updated_at).toLocaleString()
    : null;

  // Build map of normalized IPv6 -> Device object
  const ipv6ToDeviceMap = new Map();
  allDevices.forEach(dev => {
    if (dev.ipv6Address) {
      const norm = normalizeIpv6(dev.ipv6Address);
      if (norm) ipv6ToDeviceMap.set(norm, dev);
    }
    if (dev.ipv6_address) {
      const norm = normalizeIpv6(dev.ipv6_address);
      if (norm) ipv6ToDeviceMap.set(norm, dev);
    }
  });

  // Find registered home devices (non-IB) missing from the neighbor table
  const neighborNormSet = new Set(
    neighborsList.map(n => normalizeIpv6(n.neighbor_ipv6)).filter(Boolean)
  );

  const missingRegisteredDevices = allDevices.filter(dev => {
    const isIb = dev.deviceType?.startsWith('IB') || dev.deviceType === 'GW' || dev.deviceType === 'BRIDGE' || dev.serialNo?.startsWith('IB');
    if (isIb) return false;
    const devNormIp = normalizeIpv6(dev.ipv6Address || dev.ipv6_address);
    if (!devNormIp) return false;
    return !neighborNormSet.has(devNormIp);
  });

  const handleDeviceClick = (targetSerial) => {
    if (!targetSerial) return;
    if (onSelectDevice) onSelectDevice(targetSerial);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('section', 'devices');
    nextParams.set('deviceId', targetSerial);
    setSearchParams(nextParams);
  };

  const handleConfirmUnassociate = async () => {
    if (!unassociateTargetIp || isReadOnly) return;
    setIsUnassociating(true);
    try {
      await unassociateNeighbor(homeId, ibDeviceId, unassociateTargetIp);
      showToast(`Unassociation request sent for ${unassociateTargetIp}`, 'success');
      if (mutateDevice) mutateDevice();
    } catch (err) {
      showToast(`Failed to unassociate ${unassociateTargetIp}: ${err.message}`, 'error');
    } finally {
      setIsUnassociating(false);
      setUnassociateTargetIp(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', width: '100%' }}>
      {/* Header Card */}
      <Card style={{ padding: '1.25rem', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Network size={20} style={{ color: 'var(--primary)' }} />
            <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
              {t('settings.neighbors_table.title')}
            </h3>
          </div>

          {updatedAtStr && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', backgroundColor: 'var(--card-bg-subtle, rgba(255,255,255,0.05))', padding: '0.35rem 0.6rem', borderRadius: 'var(--radius-sm)' }}>
              {t('settings.neighbors_table.last_bootup_update', { time: updatedAtStr })}
            </span>
          )}
        </div>

        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
          {t('settings.neighbors_table.desc')}
        </p>
        {neighborsList.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {t('settings.neighbors_table.no_neighbors')}
          </div>
        ) : (
          neighborsList.map((neighbor, idx) => {
            const rawIp = neighbor.neighbor_ipv6 || 'Unknown';
            const normIp = normalizeIpv6(rawIp);
            const matchedDev = normIp ? ipv6ToDeviceMap.get(normIp) : null;

            if (matchedDev) {
              const serial = matchedDev.serialNo || matchedDev.shortSerialNo;
              const title = matchedDev.friendlyName
                ? `${matchedDev.friendlyName} (${serial})`
                : serial;
              const subtitle = `IPv6: ${rawIp} • ${matchedDev.deviceType || 'Device'}`;
              return (
                <ListItem
                  key={idx}
                  icon={<Smartphone size={18} style={{ color: matchedDev.connectionState?.value ? 'var(--success)' : 'var(--text-muted)' }} />}
                  title={title}
                  subtitle={subtitle}
                  onClick={() => handleDeviceClick(serial)}
                  showChevron={true}
                />
              );
            }

            return (
              <ListItem
                key={idx}
                icon={<HelpCircle size={18} style={{ color: '#ef4444' }} />}
                title={`IPv6: ${rawIp}`}
                subtitle={t('settings.neighbors_table.unknown_device')}
                showChevron={false}
                value={
                  <Button
                    variant="danger"
                    size="small"
                    disabled={isReadOnly}
                    onClick={(e) => {
                      e.stopPropagation();
                      setUnassociateTargetIp(rawIp);
                    }}
                    style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem', gap: '0.25rem' }}
                  >
                    <Trash2 size={12} />
                    {t('settings.neighbors_table.unassociate')}
                  </Button>
                }
              />
            );
          })
        )}
      </Card>

      {/* Missing Devices Warning Section */}
      {missingRegisteredDevices.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <Card style={{ padding: '1rem 1.25rem', backgroundColor: 'rgba(245, 158, 11, 0.1)', border: '1px solid #f59e0b' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f59e0b', marginBottom: '0.35rem' }}>
              <AlertTriangle size={18} />
              <strong style={{ fontSize: '0.9rem' }}>
                {t('settings.neighbors_table.missing_title', { count: missingRegisteredDevices.length })}
              </strong>
            </div>
            <p style={{ fontSize: '0.8rem', margin: 0, lineHeight: '1.4', color: 'var(--text-primary)' }}>
              {t('settings.neighbors_table.missing_desc')}
            </p>
          </Card>

          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {missingRegisteredDevices.map((dev, idx) => {
              const serial = dev.serialNo || dev.shortSerialNo;
              const title = dev.friendlyName ? `${dev.friendlyName} (${serial})` : serial;
              const devIp = dev.ipv6Address || dev.ipv6_address || 'N/A';
              const subtitle = `IPv6: ${devIp} • ${dev.deviceType || 'Device'}`;
              return (
                <ListItem
                  key={idx}
                  icon={<AlertTriangle size={18} style={{ color: '#f59e0b' }} />}
                  title={title}
                  subtitle={subtitle}
                  onClick={() => handleDeviceClick(serial)}
                  showChevron={true}
                />
              );
            })}
          </Card>
        </div>
      )}

      {/* Unassociate Confirmation Modal */}
      {unassociateTargetIp && (
        <ConfirmModal
          isOpen={true}
          title={t('settings.neighbors_table.modal_title')}
          message={t('settings.neighbors_table.modal_message', { ip: unassociateTargetIp })}
          confirmLabel={t('settings.neighbors_table.unassociate')}
          confirmVariant="danger"
          isLoading={isUnassociating}
          onConfirm={handleConfirmUnassociate}
          onCancel={() => setUnassociateTargetIp(null)}
        />
      )}
    </div>
  );
}

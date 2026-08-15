/**
 * @file src/components/zone/ZoneDetailHeader.jsx
 * @brief Renders the top header layout bar inside the ZoneDetail sidebar sheet.
 */


import { X } from 'lucide-react';

/**
 * @brief Zone detail overlay header sub-panel.
 * @param {string} props.zoneName - Zone name label.
 * @param {function} props.onClose - Overlay close click event callback.
 */
export default function ZoneDetailHeader({ zoneName, onClose }) {
  return (
    <div className="modal-header-bar">
      <button 
        onClick={onClose} 
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#ffffff' }}
      >
        <X size={24} />
      </button>
      
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0 }}>
        {zoneName}
      </h2>

      <div style={{ width: '24px' }} />
    </div>
  );
}

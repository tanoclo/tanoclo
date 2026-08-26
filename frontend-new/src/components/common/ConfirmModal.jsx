/**
 * @file src/components/common/ConfirmModal.jsx
 * @brief Renders a standard confirmation dialog wrapper over Modal.
 */


import Modal from './Modal';
import Button from './Button';

/**
 * @brief Dialog window requesting action confirmation from user.
 * @param {boolean} props.isOpen - Whether the confirmation overlay is visible.
 * @param {function} props.onClose - Trigger callback when dismiss/cancel is clicked.
 * @param {function} props.onConfirm - Trigger callback when confirm is clicked.
 * @param {string} props.title - Modal title text.
 * @param {string} props.message - Descriptive warning/clarification message.
 * @param {string} props.confirmText - Label text of confirm button.
 * @param {string} props.cancelText - Label text of cancel button.
 * @param {string} props.variant - Theme style variant for confirm button ('primary', 'destructive').
 */
export default function ConfirmModal({ 
  isOpen, 
  onClose, 
  onCancel,
  onConfirm, 
  title, 
  message, 
  confirmText = 'Confirm', 
  cancelText = 'Cancel', 
  variant = 'primary',
  isLoading = false
}) {
  const handleClose = onClose || onCancel;
  const resolvedVariant = variant === 'danger' ? 'destructive' : variant;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
          {message}
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <Button variant="secondary" onClick={handleClose} disabled={isLoading}>
            {cancelText}
          </Button>
          <Button variant={resolvedVariant} onClick={onConfirm} disabled={isLoading}>
            {confirmText}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

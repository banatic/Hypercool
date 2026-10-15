import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import './Modal.css';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

/** 데스크톱에서는 가운데 대화상자, 모바일에서는 아래에서 올라오는 시트 */
export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children }) => {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title || '상세'}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-grabber" aria-hidden="true" />
          {title && <h3 className="modal-title">{title}</h3>}
          <button ref={closeRef} type="button" className="modal-close" onClick={onClose} aria-label="닫기">
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
};

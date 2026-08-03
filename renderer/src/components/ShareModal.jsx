import { useEffect, useRef, useState } from 'react';
import { generateBillImage, shareSaveImage, shareReveal } from '../services/ipc';
import { base64ToBlob, withTimeout } from '../utils';
import { IMAGE_GEN_TIMEOUT_MS } from '../constants';
import {
  IMAGE_TIMED_OUT, IMAGE_FAILED, IMAGE_COPIED, IMAGE_COPY_FAILED,
  SAVE_FAILED, SAVED_TO, SHARE_TITLE, SHARE_HINT, PREPARING_IMAGE, COPY_IMAGE,
  SHOW_IN_FOLDER, CLOSE_LABEL,
} from '../strings';

export default function ShareModal({ bill, onClose, addToast }) {
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const imageRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    withTimeout(generateBillImage(bill.id), IMAGE_GEN_TIMEOUT_MS).then((result) => {
      if (!mounted) return;
      if (result.success) {
        imageRef.current = result;
        setReady(true);
      } else {
        addToast(IMAGE_FAILED(result.reason), 'error');
        onClose();
      }
    }).catch(() => {
      if (!mounted) return;
      addToast(IMAGE_TIMED_OUT, 'error');
      onClose();
    });
    return () => { mounted = false; };
  }, [bill.id]);

  const copyImage = async () => {
    if (!imageRef.current) return;
    setBusy(true);
    try {
      const result = imageRef.current;
      const blob = base64ToBlob(result.data, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      addToast(IMAGE_COPIED, 'success');
      onClose();
    } catch {
      addToast(IMAGE_COPY_FAILED, 'error');
    } finally {
      setBusy(false);
    }
  };

  const revealImage = async () => {
    if (!imageRef.current) return;
    setBusy(true);
    const saved = await shareSaveImage({ data: imageRef.current.data, name: imageRef.current.name });
    if (!saved.success) {
      addToast(SAVE_FAILED(saved.reason), 'error');
      setBusy(false);
      return;
    }
    await shareReveal(saved.path);
    addToast(SAVED_TO(saved.path), 'success');
    setBusy(false);
    onClose();
  };

  return (
    <div className="modal-backdrop open" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{SHARE_TITLE}</h2>
        <p className="muted">{bill.bill_number}</p>
        <p className="muted">
          {SHARE_HINT}
        </p>
        <div className="modal-actions">
          {!ready ? (
            <button className="btn primary" disabled>{PREPARING_IMAGE}</button>
          ) : (
            <>
              <button className="btn primary" onClick={copyImage} disabled={busy}>{COPY_IMAGE}</button>
              <button className="btn ghost" onClick={revealImage} disabled={busy}>{SHOW_IN_FOLDER}</button>
            </>
          )}
          <button className="btn ghost" onClick={onClose} disabled={busy}>{CLOSE_LABEL}</button>
        </div>
      </div>
    </div>
  );
}

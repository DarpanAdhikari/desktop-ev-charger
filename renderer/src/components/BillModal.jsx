import { useEffect, useState } from 'react';
import { generateBillPdf, generateBillImage, getBillPreview } from '../services/ipc';
import { base64ToBlob, withTimeout } from '../utils';
import { IMAGE_GEN_TIMEOUT_MS } from '../constants';
import ShareModal from './ShareModal';
import {
  IMAGE_TIMED_OUT, IMAGE_FAILED, IMAGE_COPIED, IMAGE_COPY_FAILED,
  PDF_SAVED, PDF_FAILED, PRINT_LABEL, SHARE_LABEL, DOWNLOAD_PDF, COPY_LABEL, LOADING_PREVIEW,
} from '../strings';

export default function BillModal({ bill, onClose, onPrint, addToast }) {
  const [previewHtml, setPreviewHtml] = useState(null);
  const [showShare, setShowShare] = useState(false);

  useEffect(() => {
    if (!bill) return;
    getBillPreview(bill.id).then((r) => {
      if (r?.html) setPreviewHtml(r.html);
    }).catch(() => {});
  }, [bill]);

  const handleCopyImage = async () => {
    let result;
    try {
      result = await withTimeout(generateBillImage(bill.id), IMAGE_GEN_TIMEOUT_MS);
    } catch {
      addToast(IMAGE_TIMED_OUT, 'error');
      return;
    }
    if (!result.success) { addToast(IMAGE_FAILED(result.reason), 'error'); return; }
    try {
      const blob = base64ToBlob(result.data, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      addToast(IMAGE_COPIED, 'success');
    } catch {
      addToast(IMAGE_COPY_FAILED, 'error');
    }
  };

  const handleDownload = async () => {
    const result = await generateBillPdf(bill.id);
    if (!result.success) { addToast(PDF_FAILED(result.reason), 'error'); return; }
    const blob = base64ToBlob(result.data, 'application/pdf');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = result.name;
    a.click();
    URL.revokeObjectURL(url);
    addToast(PDF_SAVED(result.name), 'success');
  };

  if (!bill) return null;

  return (
    <div className="modal-backdrop open" onClick={onClose}>
      <div className="modal modal-preview" onClick={(e) => e.stopPropagation()}>
        <h2>{bill.bill_number}</h2>
        <div className="bill-preview-wrap">
          {previewHtml ? (
            <iframe
              className="bill-preview-iframe"
              srcDoc={previewHtml}
              title={bill.bill_number}
              sandbox="allow-same-origin"
            />
          ) : (
            <div className="empty-state"><p>{LOADING_PREVIEW}</p></div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn primary" onClick={() => onPrint(bill.id)}>{PRINT_LABEL}</button>
          <button className="btn ghost" onClick={() => setShowShare(true)}>{SHARE_LABEL}</button>
          <button className="btn ghost" onClick={handleDownload}>{DOWNLOAD_PDF}</button>
          <button className="btn ghost" onClick={handleCopyImage}>{COPY_LABEL}</button>
        </div>
      </div>

      {showShare && (
        <ShareModal
          bill={bill}
          onClose={() => setShowShare(false)}
          addToast={addToast}
        />
      )}
    </div>
  );
}
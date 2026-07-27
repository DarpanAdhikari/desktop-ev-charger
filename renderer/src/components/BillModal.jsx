import { useEffect, useState } from 'react';
import { generateBillPdf, generateBillImage, getBillPreview } from '../services/ipc';

export default function BillModal({ bill, onClose, onPrint, addToast }) {
  const [previewHtml, setPreviewHtml] = useState(null);

  useEffect(() => {
    if (!bill) return;
    getBillPreview(bill.id).then((r) => {
      if (r?.html) setPreviewHtml(r.html);
    }).catch(() => {});
  }, [bill]);

  const handleShare = async () => {
    const result = await generateBillImage(bill.id);
    if (!result.success) { addToast(`Image failed: ${result.reason}`, 'error'); return; }
    const blob = base64ToBlob(result.data, 'image/png');
    if (navigator.share) {
      try {
        const file = new File([blob], result.name, { type: 'image/png' });
        await navigator.share({ files: [file], title: bill.bill_number });
        return;
      } catch (e) {
        if (e.name !== 'AbortError') addToast(`Share failed: ${e.message}`, 'error');
        return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = result.name;
    a.click();
    URL.revokeObjectURL(url);
    addToast(`Image saved as ${result.name}`, 'success');
  };

  const handleCopyImage = async () => {
    const result = await generateBillImage(bill.id);
    if (!result.success) { addToast(`Image failed: ${result.reason}`, 'error'); return; }
    try {
      const blob = base64ToBlob(result.data, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      addToast('Invoice image copied to clipboard', 'success');
    } catch {
      addToast('Failed to copy image to clipboard', 'error');
    }
  };

  const handleDownload = async () => {
    const result = await generateBillPdf(bill.id);
    if (!result.success) { addToast(`PDF failed: ${result.reason}`, 'error'); return; }
    const blob = base64ToBlob(result.data, 'application/pdf');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = result.name;
    a.click();
    URL.revokeObjectURL(url);
    addToast(`PDF saved as ${result.name}`, 'success');
  };

  function base64ToBlob(b64, mime) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

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
            <div className="empty-state"><p>Loading preview...</p></div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn primary" onClick={() => onPrint(bill.id)}>Print</button>
          <button className="btn ghost" onClick={handleShare}>Share</button>
          <button className="btn ghost" onClick={handleDownload}>Download PDF</button>
          <button className="btn ghost" onClick={handleCopyImage}>Copy</button>
        </div>
      </div>
    </div>
  );
}
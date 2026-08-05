// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * PDF / file attachments registered on a contract.
 *
 * Flow: upload bytes via the Documents module → register a row on the
 * contracts document register (role = executed_agreement for the main PDF).
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { Button, Card } from '@/shared/ui';
import { useToastStore } from '@/stores/useToastStore';
import { getErrorMessage } from '@/shared/lib/api';
import { uploadDocument } from '@/features/documents/api';
import { InlinePdfPreviewModal } from '@/features/file-references/InlinePdfPreviewModal';
import {
  createContractDocument,
  deleteContractDocument,
  listContractDocuments,
  type ContractDocumentItem,
} from './api';

export function ContractDocumentsPanel({
  contractId,
  projectId,
}: {
  contractId: string;
  projectId: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{
    url: string;
    title: string;
  } | null>(null);

  const docsQ = useQuery({
    queryKey: ['contracts', 'documents', contractId],
    queryFn: () => listContractDocuments(contractId),
    enabled: !!contractId,
  });

  const removeMut = useMutation({
    mutationFn: (rowId: string) => deleteContractDocument(rowId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contracts', 'documents', contractId] });
      addToast({
        type: 'success',
        title: t('contracts.doc_removed', { defaultValue: 'Document removed' }),
      });
    },
    onError: (err) => addToast({ type: 'error', title: getErrorMessage(err) }),
  });

  const onPick = async (file: File | null) => {
    if (!file || !projectId) return;
    const isPdf =
      file.type === 'application/pdf' ||
      file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      addToast({
        type: 'error',
        title: t('contracts.doc_pdf_only', {
          defaultValue: 'Please upload a PDF file',
        }),
      });
      return;
    }
    setUploading(true);
    try {
      const uploaded = await uploadDocument(projectId, file, 'contract');
      await createContractDocument({
        contract_id: contractId,
        document_id: uploaded.id,
        doc_role: 'executed_agreement',
        title: file.name.replace(/\.pdf$/i, '') || uploaded.name || 'Contract PDF',
        version: String(uploaded.version ?? 1),
        metadata: {
          filename: file.name,
          mime_type: file.type || 'application/pdf',
          size: file.size,
        },
      });
      qc.invalidateQueries({ queryKey: ['contracts', 'documents', contractId] });
      addToast({
        type: 'success',
        title: t('contracts.doc_uploaded', {
          defaultValue: 'PDF linked to contract',
        }),
      });
    } catch (err) {
      addToast({ type: 'error', title: getErrorMessage(err) });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const openDoc = (row: ContractDocumentItem) => {
    if (!row.document_id) {
      addToast({
        type: 'warning',
        title: t('contracts.doc_no_file', {
          defaultValue: 'No file attached to this register row',
        }),
      });
      return;
    }
    setPreview({
      url: `/api/v1/documents/${row.document_id}/download`,
      title:
        row.title ||
        t('contracts.doc_untitled', { defaultValue: 'Document' }),
    });
  };

  const rows = docsQ.data ?? [];

  return (
    <>
    <Card padding="sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-content-secondary">
          {t('contracts.documents', { defaultValue: 'Contract documents (PDF)' })}
          <span className="ml-2 font-normal normal-case text-content-tertiary">
            ({rows.length})
          </span>
        </p>
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
          />
          <Button
            size="sm"
            variant="secondary"
            icon={uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            disabled={uploading || !projectId}
            onClick={() => fileRef.current?.click()}
            data-testid="contract-upload-pdf"
          >
            {t('contracts.upload_pdf', { defaultValue: 'Upload PDF' })}
          </Button>
        </div>
      </div>

      {docsQ.isLoading ? (
        <p className="py-2 text-sm text-content-tertiary">
          {t('common.loading', { defaultValue: 'Loading...' })}
        </p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-sm text-content-tertiary">
          {t('contracts.documents_empty', {
            defaultValue:
              'No PDF linked yet. Upload the signed contract PDF to keep it with this record.',
          })}
        </p>
      ) : (
        <ul className="divide-y divide-border-light">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-2 py-2 text-sm"
            >
              <button
                type="button"
                onClick={() => openDoc(row)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-oe-blue"
              >
                <FileText size={14} className="shrink-0 text-oe-blue" />
                <span className="truncate font-medium">
                  {row.title || t('contracts.doc_untitled', { defaultValue: 'Document' })}
                </span>
                <span className="shrink-0 rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase text-content-tertiary">
                  {row.doc_role}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                {row.document_id && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Eye size={12} />}
                    onClick={() => openDoc(row)}
                    data-testid="contract-doc-view-pdf"
                  >
                    {t('contracts.view_pdf', { defaultValue: 'View PDF' })}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={12} />}
                  loading={removeMut.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        t('contracts.doc_remove_confirm', {
                          defaultValue: 'Remove this document from the contract?',
                        }),
                      )
                    ) {
                      removeMut.mutate(row.id);
                    }
                  }}
                >
                  {t('common.remove', { defaultValue: 'Remove' })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
    <InlinePdfPreviewModal
      open={!!preview}
      downloadUrl={preview?.url ?? null}
      title={preview?.title ?? ''}
      onClose={() => setPreview(null)}
    />
    </>
  );
}

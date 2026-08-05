// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
/**
 * Show local PDF paths for a THCC-synced contract; allow re-binding absolute paths
 * and open the same in-app PDF viewer used by project files.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FolderOpen,
  Link2,
} from 'lucide-react';
import { Button, Card } from '@/shared/ui';
import { useToastStore } from '@/stores/useToastStore';
import { getErrorMessage } from '@/shared/lib/api';
import { InlinePdfPreviewModal } from '@/features/file-references/InlinePdfPreviewModal';
import {
  listThccContractFiles,
  relocateThccContractFile,
  thccContractPdfContentUrl,
} from './api';

export function ThccLocalFilesPanel({ contractId }: { contractId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [editingRel, setEditingRel] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const [preview, setPreview] = useState<{
    url: string;
    title: string;
  } | null>(null);

  const filesQ = useQuery({
    queryKey: ['contracts', 'thcc-files', contractId],
    queryFn: () => listThccContractFiles(contractId),
    enabled: !!contractId,
  });

  const relocateMut = useMutation({
    mutationFn: () =>
      relocateThccContractFile(contractId, {
        old_relpath: editingRel,
        new_absolute: newPath.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contracts', 'thcc-files', contractId] });
      setEditingRel(null);
      setNewPath('');
      addToast({
        type: 'success',
        title: t('contracts.thcc_relocated', { defaultValue: 'Path updated' }),
      });
    },
    onError: (e) => addToast({ type: 'error', title: getErrorMessage(e) }),
  });

  const data = filesQ.data;
  // Hide panel if this contract has no THCC binding and no files
  if (!filesQ.isLoading && data && !data.folder_relpath && (data.files?.length ?? 0) === 0) {
    return null;
  }

  const files = data?.files ?? [];

  return (
    <Card padding="sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-content-secondary">
          {t('contracts.thcc_local_files', { defaultValue: 'Local files (no copy)' })}
          {data && data.missing_count > 0 && (
            <span className="ml-2 normal-case text-amber-600">
              {data.missing_count}{' '}
              {t('contracts.thcc_missing', { defaultValue: 'missing' })}
            </span>
          )}
        </p>
        {data?.folder_relpath && (
          <span className="max-w-[14rem] truncate text-[10px] text-content-tertiary" title={data.folder_relpath}>
            {data.folder_relpath}
          </span>
        )}
      </div>

      {filesQ.isLoading ? (
        <p className="text-sm text-content-tertiary">
          {t('common.loading', { defaultValue: 'Loading...' })}
        </p>
      ) : files.length === 0 ? (
        <p className="text-sm text-content-tertiary">
          {t('contracts.thcc_no_pdfs', {
            defaultValue: 'No PDF paths registered. Run Sync from the project contracts list.',
          })}
        </p>
      ) : (
        <ul className="space-y-2">
          {files.map((f) => (
            <li
              key={f.relpath}
              className="rounded-md border border-border-light px-2 py-1.5 text-sm"
            >
              <div className="flex items-center gap-2">
                {f.exists ? (
                  <CheckCircle2 size={14} className="shrink-0 text-emerald-600" />
                ) : (
                  <AlertTriangle size={14} className="shrink-0 text-amber-600" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium" title={f.absolute}>
                  {f.name}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Eye size={12} />}
                  disabled={!f.exists}
                  onClick={() =>
                    setPreview({
                      url: thccContractPdfContentUrl(contractId, f.relpath),
                      title: f.name,
                    })
                  }
                  data-testid="thcc-pdf-view"
                >
                  {t('contracts.view_pdf', { defaultValue: 'View PDF' })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Link2 size={12} />}
                  onClick={() => {
                    setEditingRel(f.relpath);
                    setNewPath(f.exists ? f.absolute : '');
                  }}
                >
                  {t('contracts.thcc_relocate', { defaultValue: 'Relocate' })}
                </Button>
              </div>
              <p className="mt-0.5 truncate pl-5 text-[10px] text-content-tertiary" title={f.absolute}>
                {f.absolute}
              </p>
              {editingRel === f.relpath && (
                <div className="mt-2 flex flex-wrap items-end gap-2 pl-5">
                  <label className="min-w-[12rem] flex-1 text-[10px] text-content-tertiary">
                    {t('contracts.thcc_new_abs', {
                      defaultValue: 'New absolute path on this Mac',
                    })}
                    <input
                      value={newPath}
                      onChange={(e) => setNewPath(e.target.value)}
                      className="mt-0.5 h-8 w-full rounded border border-border bg-surface-primary px-2 text-xs"
                      placeholder="/Users/…/合同扫描件.pdf"
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={relocateMut.isPending}
                    icon={<FolderOpen size={12} />}
                    onClick={() => relocateMut.mutate()}
                  >
                    {t('common.save', { defaultValue: 'Save' })}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingRel(null);
                      setNewPath('');
                    }}
                  >
                    {t('common.cancel', { defaultValue: 'Cancel' })}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <InlinePdfPreviewModal
        open={!!preview}
        downloadUrl={preview?.url ?? null}
        title={preview?.title ?? ''}
        onClose={() => setPreview(null)}
      />
    </Card>
  );
}

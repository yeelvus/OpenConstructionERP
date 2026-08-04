// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
/**
 * Scan / sync local THCC contract folders into OCE (path registry only).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderSync, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { Button, Card } from '@/shared/ui';
import { useToastStore } from '@/stores/useToastStore';
import { getErrorMessage } from '@/shared/lib/api';
import {
  getThccContractsConfig,
  rescanThccPaths,
  scanThccContracts,
  setThccContractsRoot,
  syncThccContracts,
  type ThccScanResult,
} from './api';

export function ThccLocalSyncPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [rootDraft, setRootDraft] = useState('');
  const [lastScan, setLastScan] = useState<ThccScanResult | null>(null);
  const [showRoot, setShowRoot] = useState(false);

  const configQ = useQuery({
    queryKey: ['contracts', 'thcc-config'],
    queryFn: getThccContractsConfig,
    staleTime: 30_000,
  });

  const scanMut = useMutation({
    mutationFn: () => scanThccContracts({ project_id: projectId }),
    onSuccess: (data) => {
      setLastScan(data);
      addToast({
        type: 'success',
        title: t('contracts.thcc_scan_ok', {
          defaultValue: 'Scan complete: {{n}} local contract(s)',
          n: data.count,
        }),
      });
    },
    onError: (e) => addToast({ type: 'error', title: getErrorMessage(e) }),
  });

  const syncMut = useMutation({
    mutationFn: () => syncThccContracts({ project_id: projectId }),
    onSuccess: (data) => {
      setLastScan(data);
      qc.invalidateQueries({ queryKey: ['contracts', 'list'] });
      addToast({
        type: 'success',
        title: t('contracts.thcc_sync_ok', {
          defaultValue: 'Synced: +{{c}} · updated {{u}} · skip {{s}}',
          c: data.summary.created ?? 0,
          u: data.summary.updated ?? 0,
          s: data.summary.skipped ?? 0,
        }),
      });
    },
    onError: (e) => addToast({ type: 'error', title: getErrorMessage(e) }),
  });

  const rescanMut = useMutation({
    mutationFn: () => rescanThccPaths({ project_id: projectId }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['contracts'] });
      addToast({
        type: 'success',
        title: t('contracts.thcc_rescan_ok', {
          defaultValue: 'Paths refreshed ({{n}} contracts, {{m}} still missing)',
          n: data.refreshed_from_scan,
          m: data.still_missing_files,
        }),
      });
    },
    onError: (e) => addToast({ type: 'error', title: getErrorMessage(e) }),
  });

  const saveRootMut = useMutation({
    mutationFn: () => setThccContractsRoot(rootDraft.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contracts', 'thcc-config'] });
      addToast({
        type: 'success',
        title: t('contracts.thcc_root_saved', { defaultValue: 'Contracts root saved' }),
      });
      setShowRoot(false);
    },
    onError: (e) => addToast({ type: 'error', title: getErrorMessage(e) }),
  });

  const cfg = configQ.data;
  const busy = scanMut.isPending || syncMut.isPending || rescanMut.isPending;

  return (
    <Card padding="sm" className="mb-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-content-primary">
            {t('contracts.thcc_sync_title', {
              defaultValue: 'Local contract folder (邯郸中材)',
            })}
          </p>
          <p className="mt-0.5 text-xs text-content-tertiary break-all">
            {cfg
              ? `${cfg.root}${cfg.exists ? '' : '  ⚠ not found'}`
              : t('common.loading', { defaultValue: 'Loading...' })}
          </p>
          <p className="mt-1 text-xs text-content-secondary">
            {t('contracts.thcc_sync_hint', {
              defaultValue:
                'Scans folders that contain THCC-YYYY-NNN project codes and 合同信息.json. Files stay on disk — only paths are registered.',
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            icon={<Settings2 size={14} />}
            onClick={() => {
              setRootDraft(cfg?.root || '');
              setShowRoot((v) => !v);
            }}
          >
            {t('contracts.thcc_set_root', { defaultValue: 'Root path' })}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            disabled={busy || !projectId}
            onClick={() => scanMut.mutate()}
          >
            {t('contracts.thcc_scan', { defaultValue: 'Scan' })}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            disabled={busy || !projectId}
            onClick={() => rescanMut.mutate()}
          >
            {t('contracts.thcc_rescan_paths', { defaultValue: 'Fix paths' })}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={syncMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <FolderSync size={14} />}
            disabled={busy || !projectId}
            onClick={() => {
              if (
                window.confirm(
                  t('contracts.thcc_sync_confirm', {
                    defaultValue:
                      'Import/update contracts for this project from the local folder? No files will be copied.',
                  }),
                )
              ) {
                syncMut.mutate();
              }
            }}
            data-testid="thcc-contracts-sync"
          >
            {t('contracts.thcc_sync', { defaultValue: 'Sync to project' })}
          </Button>
        </div>
      </div>

      {showRoot && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border-light pt-3">
          <label className="min-w-[16rem] flex-1 text-xs">
            <span className="text-content-tertiary">
              {t('contracts.thcc_root_label', {
                defaultValue: 'Absolute path to 5_合同管理 folder',
              })}
            </span>
            <input
              value={rootDraft}
              onChange={(e) => setRootDraft(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-border bg-surface-primary px-2 text-sm"
              placeholder="/Users/…/5_合同管理📑"
            />
          </label>
          <Button
            size="sm"
            variant="primary"
            loading={saveRootMut.isPending}
            onClick={() => saveRootMut.mutate()}
          >
            {t('common.save', { defaultValue: 'Save' })}
          </Button>
        </div>
      )}

      {lastScan && (
        <div className="mt-3 rounded-lg border border-border-light bg-surface-secondary/40 px-3 py-2 text-xs text-content-secondary">
          <span className="font-medium text-content-primary">
            {t('contracts.thcc_last_result', { defaultValue: 'Last result' })}:
          </span>{' '}
          {lastScan.count}{' '}
          {t('contracts.contracts_label', { defaultValue: 'contracts' })}
          {lastScan.summary && (
            <span className="ml-2 text-content-tertiary">
              {Object.entries(lastScan.summary)
                .map(([k, v]) => `${k}=${v}`)
                .join(' · ')}
            </span>
          )}
          {lastScan.items.filter((i) => i.project_match === 'missing').length > 0 && (
            <p className="mt-1 text-amber-700 dark:text-amber-400">
              {t('contracts.thcc_missing_projects', {
                defaultValue:
                  '{{n}} local contract(s) have no matching OCE project (check project_code).',
                n: lastScan.items.filter((i) => i.project_match === 'missing').length,
              })}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

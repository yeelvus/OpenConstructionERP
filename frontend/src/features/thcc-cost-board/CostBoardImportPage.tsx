// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
/**
 * 月度导入 — load data_latest.json + labour HTML into cost board tables.
 */

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  FileJson,
  FolderOpen,
  HardDrive,
  Loader2,
  Upload,
} from 'lucide-react';
import { Button, Card, EmptyState } from '@/shared/ui';
import { PageHeader } from '@/shared/ui/PageHeader';
import { apiPost, getErrorMessage } from '@/shared/lib/api';
import { useToastStore } from '@/stores/useToastStore';
import {
  fetchImportPaths,
  fetchSnapshots,
  importFromDisk,
  importJsonFile,
  importLaborHtmlFile,
  type ImportResult,
} from './api';

export function CostBoardImportPage() {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const jsonRef = useRef<HTMLInputElement>(null);
  const htmlRef = useRef<HTMLInputElement>(null);
  const [last, setLast] = useState<ImportResult | null>(null);

  const pathsQ = useQuery({
    queryKey: ['thcc-cost-board', 'import-paths'],
    queryFn: fetchImportPaths,
    retry: false,
  });

  const snapsQ = useQuery({
    queryKey: ['thcc-cost-board', 'snapshots'],
    queryFn: fetchSnapshots,
    retry: false,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['thcc-cost-board'] });
  };

  const diskM = useMutation({
    mutationFn: () => importFromDisk({ replace: true, include_labor: true }),
    onSuccess: (r) => {
      setLast(r);
      addToast({ type: 'success', title: r.message || '导入成功' });
      invalidate();
    },
    onError: (e) =>
      addToast({ type: 'error', title: '导入失败', message: getErrorMessage(e) }),
  });

  const jsonM = useMutation({
    mutationFn: (file: File) => importJsonFile(file, true),
    onSuccess: (r) => {
      setLast(r);
      addToast({ type: 'success', title: r.message || 'JSON 导入成功' });
      invalidate();
    },
    onError: (e) =>
      addToast({ type: 'error', title: 'JSON 导入失败', message: getErrorMessage(e) }),
  });

  const laborM = useMutation({
    mutationFn: (file: File) => importLaborHtmlFile(file),
    onSuccess: (r) => {
      setLast(r);
      addToast({ type: 'success', title: r.message || '人工 HTML 导入成功' });
      invalidate();
    },
    onError: (e) =>
      addToast({ type: 'error', title: '人工导入失败', message: getErrorMessage(e) }),
  });

  const busy = diskM.isPending || jsonM.isPending || laborM.isPending;
  const paths = pathsQ.data;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 text-sm">
        <Link
          to="/cost-board"
          className="inline-flex items-center gap-1 text-content-secondary hover:text-oe-blue-text"
        >
          <ArrowLeft className="h-4 w-4" />
          组合层
        </Link>
      </div>

      <PageHeader
        srTitle="月度导入"
        subtitle="将 Z_report 综合成本看板 JSON / 人工费 HTML 导入为可查询快照。未来可对接财务付款、合同等实时源。"
      />

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <HardDrive className="h-4 w-4" />
          默认磁盘路径（Mac Desktop 或 Docker /host/thcc）
        </div>
        {pathsQ.isLoading ? (
          <div className="text-sm text-content-secondary">读取路径…</div>
        ) : pathsQ.isError ? (
          <div className="text-sm text-red-600">{getErrorMessage(pathsQ.error)}</div>
        ) : paths ? (
          <dl className="space-y-2 text-xs font-mono break-all">
            <PathRow
              label="THCC root"
              path={paths.thcc_root}
              ok={Boolean(paths.thcc_root)}
            />
            <PathRow
              label="data_latest.json"
              path={paths.cost_board_json}
              ok={paths.cost_board_json_exists}
            />
            <PathRow
              label="人工费 HTML"
              path={paths.labor_html}
              ok={paths.labor_html_exists}
            />
            <PathRow
              label="人工费 xlsx"
              path={paths.labor_xlsx}
              ok={paths.labor_xlsx_exists}
            />
          </dl>
        ) : (
          <EmptyState title="无路径信息" description="后端可能尚未加载本模块。" />
        )}

        <Button
          disabled={busy || !paths?.cost_board_json_exists}
          onClick={() => diskM.mutate()}
        >
          {diskM.isPending ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <FolderOpen className="h-4 w-4 mr-1" />
          )}
          从磁盘一键导入（JSON + 人工 HTML）
        </Button>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Upload className="h-4 w-4" />
          手动上传
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={jsonRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) jsonM.mutate(f);
              e.target.value = '';
            }}
          />
          <input
            ref={htmlRef}
            type="file"
            accept=".html,text/html"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) laborM.mutate(f);
              e.target.value = '';
            }}
          />
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => jsonRef.current?.click()}
          >
            {jsonM.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <FileJson className="h-4 w-4 mr-1" />
            )}
            上传 data_latest.json
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => htmlRef.current?.click()}
          >
            {laborM.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-1" />
            )}
            上传人工费 HTML
          </Button>
        </div>
      </Card>

      {last ? (
        <Card className="p-4 border-emerald-200 dark:border-emerald-900">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
            <div className="text-sm space-y-1">
              <div className="font-medium">{last.message}</div>
              <div className="text-xs text-content-secondary">
                period={last.period || '—'} · projects={last.project_count} · linked=
                {last.linked_projects} · labor_rows={last.labor_rows} · replaced=
                {String(last.replaced)}
              </div>
              <Link to="/cost-board" className="text-oe-blue-text hover:underline text-xs">
                查看组合层 →
              </Link>
            </div>
          </div>
        </Card>
      ) : null}

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <HardDrive className="h-4 w-4" />
          责任成本 → 财务预算
        </div>
        <p className="text-xs text-content-secondary">
          扫描{' '}
          <span className="font-mono">
            3.1_责任成本/2_责任成本_std
          </span>
          ，将各项目明细行写入财务模块预算成本（并可回写看板责任成本）。
        </p>
        <Button
          disabled={busy}
          variant="secondary"
          onClick={() => {
            void (async () => {
              try {
                const r = await apiPost<{
                  ok: boolean;
                  message?: string;
                  ok_files?: number;
                  fail_files?: number;
                  created?: number;
                  updated?: number;
                }>(
                  '/v1/finance/budgets/thcc-resp-cost/import/',
                  { replace: true, sync_cost_board: true },
                  { longRunning: true },
                );
                addToast({
                  type: r.ok || (r.ok_files ?? 0) > 0 ? 'success' : 'error',
                  title: '责任成本导入',
                  message:
                    r.message ||
                    `成功文件 ${r.ok_files ?? 0}，失败 ${r.fail_files ?? 0}，新建 ${r.created ?? 0}，更新 ${r.updated ?? 0}`,
                });
                invalidate();
              } catch (e) {
                addToast({
                  type: 'error',
                  title: '责任成本导入失败',
                  message: getErrorMessage(e),
                });
              }
            })();
          }}
        >
          <FolderOpen className="h-4 w-4 mr-1" />
          批量导入责任成本为预算
        </Button>
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-2">已导入快照</h3>
        {snapsQ.isLoading ? (
          <div className="text-sm text-content-secondary">加载…</div>
        ) : !snapsQ.data?.items.length ? (
          <div className="text-sm text-content-secondary">暂无快照</div>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {snapsQ.data.items.map((s) => (
              <li key={s.id} className="py-2 flex justify-between gap-2">
                <div>
                  <div className="font-medium">
                    {s.period_label || s.period} · {s.title}
                  </div>
                  <div className="text-2xs text-content-secondary">
                    {s.project_count} 项目 · 导入 {s.imported_at || '—'} · 源生成{' '}
                    {s.source_generated_at || '—'}
                  </div>
                </div>
                <span className="text-2xs uppercase text-content-secondary">{s.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PathRow({
  label,
  path,
  ok,
}: {
  label: string;
  path: string | null | undefined;
  ok: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span
        className={`shrink-0 mt-0.5 h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-400'}`}
      />
      <div>
        <div className="text-content-secondary font-sans text-2xs uppercase">{label}</div>
        <div>{path || '—'}</div>
      </div>
    </div>
  );
}

export default CostBoardImportPage;

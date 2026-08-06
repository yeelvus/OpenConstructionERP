// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
/**
 * 人工专题 — monthly labour composition & cumulative trends.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowLeft, Search, Upload } from 'lucide-react';
import { Badge, Button, Card, EmptyState, SkeletonTable } from '@/shared/ui';
import { PageHeader } from '@/shared/ui/PageHeader';
import { getErrorMessage } from '@/shared/lib/api';
import { fetchLaborCatalog, fetchLaborSeries } from './api';
import { fmtWan, LABOR_CAT_COLORS, LABOR_CAT_LABELS } from './format';

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-surface-primary px-3 text-sm focus:outline-none focus:ring-2 focus:ring-oe-blue/30';

const SERIES_CATS = [
  'zh_formal',
  'zh_labor',
  'local_labor',
  'outsourcing_labor',
  'visa_fee',
] as const;

export function LaborBoardPage() {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'monthly' | 'cumulative'>('cumulative');

  const catalogQ = useQuery({
    queryKey: ['thcc-cost-board', 'labor-catalog'],
    queryFn: fetchLaborCatalog,
    retry: false,
  });

  const projects = useMemo(() => {
    const list = catalogQ.data?.projects ?? [];
    const qq = q.trim().toLowerCase();
    if (!qq) return list;
    return list.filter(
      (p) =>
        p.project_name.toLowerCase().includes(qq) ||
        (p.project_code || '').toLowerCase().includes(qq),
    );
  }, [catalogQ.data, q]);

  const activeKey = selected || projects[0]?.project_key || null;

  const seriesQ = useQuery({
    queryKey: ['thcc-cost-board', 'labor-series', activeKey],
    queryFn: () => fetchLaborSeries({ project_key: activeKey! }),
    enabled: Boolean(activeKey),
    retry: false,
  });

  const chartData = useMemo(() => {
    const s = seriesQ.data;
    if (!s) return [];
    const src = mode === 'cumulative' ? s.cumulative : s.series;
    return s.months.map((m, i) => {
      const row: Record<string, string | number> = { month: m };
      for (const cat of SERIES_CATS) {
        row[cat] = (src[cat] || [])[i] ?? 0;
      }
      row.total_labor = (src.total_labor || [])[i] ?? 0;
      return row;
    });
  }, [seriesQ.data, mode]);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 max-w-[1600px] mx-auto">
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
        srTitle="人工费专题"
        subtitle="按项目查看月度人工构成与累计趋势（中方正式/劳务、属地、中介、签证）"
        actions={
          <Button variant="secondary" size="sm" onClick={() => { window.location.href = '/cost-board/import'; }}>
            <Upload className="h-4 w-4 mr-1" />
            导入
          </Button>
        }
      />

      {catalogQ.isLoading ? (
        <SkeletonTable rows={6} />
      ) : catalogQ.isError || !catalogQ.data?.projects.length ? (
        <EmptyState
          title="尚无人工序列数据"
          description={
            getErrorMessage(catalogQ.error) ||
            '请在「月度导入」中导入人工费汇总分析 HTML，或从磁盘一键导入。'
          }
          action={
            <Link to="/cost-board/import" className="text-oe-blue-text text-sm hover:underline">
              去导入
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
          <Card className="p-3 max-h-[70vh] overflow-auto">
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-content-secondary" />
              <input
                className={`${inputCls} pl-8`}
                placeholder="筛选项目"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="text-2xs text-content-secondary mb-2">
              {projects.length} / {catalogQ.data.projects.length} 项目
            </div>
            <ul className="space-y-0.5">
              {projects.map((p) => (
                <li key={p.project_key}>
                  <button
                    type="button"
                    onClick={() => setSelected(p.project_key)}
                    className={`w-full text-left rounded-md px-2 py-1.5 text-sm transition-colors ${
                      activeKey === p.project_key
                        ? 'bg-oe-blue/15 text-oe-blue-text font-medium'
                        : 'hover:bg-surface-secondary text-content-primary'
                    }`}
                  >
                    <div className="truncate">{p.project_name}</div>
                    <div className="flex justify-between text-2xs text-content-secondary">
                      <span className="font-mono">{p.project_code || p.project_key}</span>
                      <span className="tabular-nums">{fmtWan(p.total_amount)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-base font-semibold">
                    {seriesQ.data?.project_name || '—'}
                  </h3>
                  <div className="text-xs text-content-secondary font-mono">
                    {seriesQ.data?.project_code || seriesQ.data?.project_key}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className={`rounded px-2 py-1 text-xs ${mode === 'cumulative' ? 'bg-oe-blue text-white' : 'bg-surface-secondary'}`}
                    onClick={() => setMode('cumulative')}
                  >
                    累计趋势
                  </button>
                  <button
                    type="button"
                    className={`rounded px-2 py-1 text-xs ${mode === 'monthly' ? 'bg-oe-blue text-white' : 'bg-surface-secondary'}`}
                    onClick={() => setMode('monthly')}
                  >
                    月度构成
                  </button>
                </div>
              </div>

              {seriesQ.isLoading ? (
                <div className="h-72 animate-pulse bg-surface-secondary rounded" />
              ) : seriesQ.isError ? (
                <div className="text-sm text-red-600">{getErrorMessage(seriesQ.error)}</div>
              ) : (
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip
                        formatter={(v: number, name: string) => [
                          fmtWan(v, 2),
                          LABOR_CAT_LABELS[name] || name,
                        ]}
                      />
                      <Legend
                        formatter={(v) => LABOR_CAT_LABELS[v] || v}
                      />
                      {SERIES_CATS.map((cat) => (
                        <Line
                          key={cat}
                          type="monotone"
                          dataKey={cat}
                          stroke={LABOR_CAT_COLORS[cat]}
                          strokeWidth={2}
                          dot={false}
                        />
                      ))}
                      <Line
                        type="monotone"
                        dataKey="total_labor"
                        stroke={LABOR_CAT_COLORS.total_labor}
                        strokeWidth={2}
                        strokeDasharray="4 3"
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            <div className="flex flex-wrap gap-2">
              {SERIES_CATS.map((cat) => (
                <Badge key={cat} variant="neutral" className="gap-1">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: LABOR_CAT_COLORS[cat] }}
                  />
                  {LABOR_CAT_LABELS[cat]}
                </Badge>
              ))}
              <Badge variant="neutral">单位：万泰铢</Badge>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LaborBoardPage;

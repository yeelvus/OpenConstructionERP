// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
/**
 * 组合层 — THCC 综合成本看板 portfolio cockpit.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Construction,
  Download,
  RefreshCw,
  Search,
  Upload,
  Users,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, SkeletonTable } from '@/shared/ui';
import { PageHeader } from '@/shared/ui/PageHeader';
import { getErrorMessage } from '@/shared/lib/api';
import { fetchPortfolio, fetchProjects, type ProjectRowSummary } from './api';
import { fmtPct, fmtWan, riskBadgeClass } from './format';

const inputCls =
  'h-9 rounded-lg border border-border bg-surface-primary px-3 text-sm focus:outline-none focus:ring-2 focus:ring-oe-blue/30';

function KpiCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'danger' | 'ok' | 'info';
}) {
  const toneCls =
    tone === 'danger'
      ? 'border-red-200 dark:border-red-900'
      : tone === 'ok'
        ? 'border-emerald-200 dark:border-emerald-900'
        : tone === 'info'
          ? 'border-oe-blue/30'
          : 'border-border';
  return (
    <Card className={`p-4 border ${toneCls}`}>
      <div className="text-2xs font-medium uppercase tracking-wide text-content-secondary">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-content-primary">{value}</div>
      {hint ? <div className="mt-1 text-xs text-content-secondary">{hint}</div> : null}
    </Card>
  );
}

export function CostBoardPage() {
  const navigate = useNavigate();
  const [bucket, setBucket] = useState<string>('');
  const [risk, setRisk] = useState<string>('');
  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');

  // simple debounce via onBlur / Enter — also apply on typing with short timer
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const onSearchChange = (v: string) => {
    setQ(v);
    if (timer) clearTimeout(timer);
    setTimer(setTimeout(() => setQDebounced(v), 300));
  };

  const portfolioQ = useQuery({
    queryKey: ['thcc-cost-board', 'portfolio'],
    queryFn: () => fetchPortfolio(),
    retry: false,
  });

  const projectsQ = useQuery({
    queryKey: ['thcc-cost-board', 'projects', bucket, risk, qDebounced],
    queryFn: () =>
      fetchProjects({
        bucket: bucket || undefined,
        risk: risk || undefined,
        q: qDebounced || undefined,
      }),
    retry: false,
  });

  const kpis = portfolioQ.data;
  const rows = projectsQ.data?.items ?? [];

  const marginChart = useMemo(() => {
    return [...rows]
      .filter((r) => r.exp_margin != null)
      .sort((a, b) => (a.exp_margin ?? 0) - (b.exp_margin ?? 0))
      .slice(0, 20)
      .map((r) => ({
        name: r.name.length > 8 ? `${r.name.slice(0, 8)}…` : r.name,
        full: r.name,
        margin: Math.round((r.exp_margin ?? 0) * 1000) / 10,
        risk: r.risk,
      }));
  }, [rows]);

  const unit = kpis?.unit || '万泰铢';
  const notFound =
    portfolioQ.isError &&
    String(getErrorMessage(portfolioQ.error)).toLowerCase().includes('not found');

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 max-w-[1600px] mx-auto">
      <PageHeader
        srTitle={kpis?.title || '综合成本看板'}
        subtitle={
          kpis
            ? `${kpis.period_label || kpis.period} · ${unit} · 生成 ${kpis.source_generated_at || '—'}${
                kpis.fx_cny_to_thb ? ` · 汇率 CNY→THB ${kpis.fx_cny_to_thb}` : ''
              }`
            : 'THCC 组合层经营成本驾驶舱（快照数据，可月度导入）'
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate('/cost-board/labor')}>
              <Users className="h-4 w-4 mr-1" />
              人工专题
            </Button>
            <Button variant="secondary" size="sm" onClick={() => navigate('/cost-board/import')}>
              <Upload className="h-4 w-4 mr-1" />
              月度导入
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void portfolioQ.refetch();
                void projectsQ.refetch();
              }}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              刷新
            </Button>
          </div>
        }
      />

      {notFound || (!portfolioQ.isLoading && !kpis) ? (
        <EmptyState
          icon={<Download className="h-8 w-8" />}
          title="尚未导入成本快照"
          description="请先从 Z_report 导入 data_latest.json（组合层 + 可选人工费 HTML）。"
          action={{
            label: '去导入',
            onClick: () => navigate('/cost-board/import'),
          }}
        />
      ) : null}

      {portfolioQ.isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="h-24 animate-pulse bg-surface-secondary" />
          ))}
        </div>
      ) : kpis ? (
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          <KpiCard
            label="在建"
            value={String(kpis.active_count)}
            hint="项目数"
            tone="info"
          />
          <KpiCard label="完工" value={String(kpis.done_count)} hint="项目数" tone="ok" />
          <KpiCard
            label="风险"
            value={String(kpis.risk_count)}
            hint="danger/warn"
            tone={kpis.risk_count > 0 ? 'danger' : 'default'}
          />
          <KpiCard label="合同额" value={fmtWan(kpis.total_contract)} hint={unit} />
          <KpiCard label="责任成本" value={fmtWan(kpis.total_resp_cost)} hint={unit} />
          <KpiCard label="已发生" value={fmtWan(kpis.total_actual)} hint={unit} />
          <KpiCard label="过程人材机" value={fmtWan(kpis.total_proc)} hint={unit} />
          <KpiCard
            label="平均预估毛利"
            value={fmtPct(kpis.avg_exp_margin)}
            hint={`投标均 ${fmtPct(kpis.avg_bid_margin)}`}
          />
        </div>
      ) : null}

      {marginChart.length > 0 ? (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-content-primary">
              预估毛利率（筛选后，取最低 20）
            </h3>
            <span className="text-xs text-content-secondary">单位 %</span>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={marginChart} margin={{ top: 8, right: 8, left: 0, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(v: number) => [`${v}%`, '预估毛利']}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.full || ''}
                />
                <Bar dataKey="margin" radius={[3, 3, 0, 0]}>
                  {marginChart.map((d, i) => (
                    <Cell
                      key={i}
                      fill={
                        d.margin < 0
                          ? '#ef4444'
                          : d.margin < 5
                            ? '#f59e0b'
                            : '#10b981'
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ) : null}

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-content-secondary" />
            <input
              className={`${inputCls} w-full pl-8`}
              placeholder="搜索编码 / 名称"
              value={q}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
          <select
            className={inputCls}
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
          >
            <option value="">全部状态桶</option>
            <option value="在建">在建</option>
            <option value="完工">完工</option>
            <option value="收尾">收尾</option>
          </select>
          <select className={inputCls} value={risk} onChange={(e) => setRisk(e.target.value)}>
            <option value="">全部风险</option>
            <option value="danger">danger</option>
            <option value="warn">warn</option>
            <option value="ok">ok</option>
          </select>
          <Badge variant="neutral">{rows.length} 项</Badge>
        </div>

        {projectsQ.isLoading ? (
          <SkeletonTable rows={8} />
        ) : projectsQ.isError ? (
          <div className="text-sm text-red-600">{getErrorMessage(projectsQ.error)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title="无项目" description="当前筛选下没有项目，或尚未导入快照。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-content-secondary">
                  <th className="py-2 pr-3 font-medium">编码</th>
                  <th className="py-2 pr-3 font-medium">项目</th>
                  <th className="py-2 pr-3 font-medium">桶</th>
                  <th className="py-2 pr-3 font-medium">风险</th>
                  <th className="py-2 pr-3 font-medium text-right">合同</th>
                  <th className="py-2 pr-3 font-medium text-right">责任成本</th>
                  <th className="py-2 pr-3 font-medium text-right">已发生</th>
                  <th className="py-2 pr-3 font-medium text-right">进度</th>
                  <th className="py-2 pr-3 font-medium text-right">预估毛利</th>
                  <th className="py-2 font-medium">预警</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <ProjectTableRow key={r.id} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="flex flex-wrap gap-3 text-xs text-content-secondary">
        <span className="inline-flex items-center gap-1">
          <Construction className="h-3.5 w-3.5" /> 在建 / 完工为快照 bucket
        </span>
        <span className="inline-flex items-center gap-1">
          <AlertTriangle className="h-3.5 w-3.5" /> 金额单位默认万泰铢（见快照 meta）
        </span>
        <span className="inline-flex items-center gap-1">
          <Building2 className="h-3.5 w-3.5" /> 点击行进入项目总览
        </span>
        <span className="inline-flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5" /> 已关联 OCE 项目时可用项目内路由
        </span>
      </div>
    </div>
  );
}

function ProjectTableRow({ row }: { row: ProjectRowSummary }) {
  const to = row.project_id
    ? `/projects/${row.project_id}/cost-board`
    : `/cost-board/projects/${row.id}`;
  return (
    <tr className="border-b border-border/60 hover:bg-surface-secondary/60 cursor-pointer">
      <td className="py-2 pr-3">
        <Link to={to} className="font-mono text-xs text-oe-blue-text hover:underline">
          {row.project_code || '—'}
        </Link>
      </td>
      <td className="py-2 pr-3">
        <Link to={to} className="font-medium text-content-primary hover:underline">
          {row.name}
        </Link>
        {row.pm ? <div className="text-2xs text-content-secondary">{row.pm}</div> : null}
      </td>
      <td className="py-2 pr-3">
        <Badge variant="neutral">{row.bucket || '—'}</Badge>
      </td>
      <td className="py-2 pr-3">
        <span className={`inline-flex rounded px-1.5 py-0.5 text-2xs font-medium ${riskBadgeClass(row.risk)}`}>
          {row.risk || '—'}
        </span>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">{fmtWan(row.contract)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{fmtWan(row.resp_cost)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{fmtWan(row.actual)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{fmtPct(row.progress)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{fmtPct(row.exp_margin)}</td>
      <td className="py-2 text-2xs text-content-secondary max-w-[180px] truncate">
        {row.alerts?.length ? row.alerts.join('；') : '—'}
      </td>
    </tr>
  );
}

export default CostBoardPage;

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  AnalysisRow,
  average,
  formatDate,
  formatHours,
  formatMAD,
  isSupabaseConfigured,
  loadAnalyses,
  summarize,
  supabaseClient,
} from './dashboard';
import { dashboardConfig } from './config';
import { generateChefReport } from './report';
import {
  getComplianceScore,
  getFillRate,
  getMainIssue,
  getPriorityLevel,
  getSeverityLevel,
  issueWeight,
  priorityWeight,
  type MainIssue,
} from './shelfguideCalculations';
import './styles.css';

type Tone = 'danger' | 'warning' | 'success' | 'primary';
type Priority = 'Haute' | 'Moyenne' | 'Faible';
type Theme = 'light' | 'dark';

interface ActionRow {
  id: string;
  store: string;
  shelf: string;
  category: string;
  status: string;
  priority: Priority;
  action: string;
  issue: MainIssue;
  recommendation: string;
  compliance: number;
  fillRate: number;
  emptyRatio: number;
  backRatio: number;
  profitability: number;
  emptySpaces: number;
  backProducts: number;
  lastAudit: string;
  score: number;
}

interface CategoryFocus {
  category: string;
  actions: number;
  avgProfitability: number;
  emptySpaces: number;
  backProducts: number;
}

interface TimelinePoint {
  label: string;
  conformity: number;
  actions: number;
  corrected: number;
}

interface ActivityItem {
  avatar: string;
  title: string;
  meta: string;
  tone: Tone;
}

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function dayKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function shortDay(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(value));
}

function isToday(value: string): boolean {
  return dayKey(value) === dayKey(new Date().toISOString());
}

function statusOf(row: AnalysisRow): string {
  return getSeverityLevel(row);
}

function toneFromStatus(status: string): Tone {
  if (status === 'Critique') return 'danger';
  if (status === 'Moyen') return 'warning';
  return 'success';
}

function toneFromPriority(priority: Priority): Tone {
  if (priority === 'Haute') return 'danger';
  if (priority === 'Moyenne') return 'warning';
  return 'success';
}

function actionFor(row: AnalysisRow): string {
  const issue = getMainIssue(row);
  if (row.recommendation.trim()) return row.recommendation.trim();
  if (issue === 'Rupture visible') return 'Recharger les facings vides';
  if (issue === 'Mauvaise orientation') return 'Remettre les produits en front';
  if (issue === 'Performance faible') return 'Verifier implantation et stock reserve';
  if (issue === 'Audit incomplet') return 'Relancer un audit complet du rayon';
  return 'Controle rapide';
}

function priorityFor(row: AnalysisRow): Priority {
  return getPriorityLevel(row);
}

function issueCount(rows: AnalysisRow[]): number {
  return rows.reduce((sum, row) => sum + row.empty_spaces + row.back_products, 0);
}

function buildActions(rows: AnalysisRow[]): ActionRow[] {
  return [...rows]
    .sort((a, b) => new Date(b.audit_date).getTime() - new Date(a.audit_date).getTime())
    .map((row) => {
      const priority = priorityFor(row);
      const compliance = getComplianceScore(row);
      const issue = getMainIssue(row);
      const score =
        (100 - compliance) +
        row.empty_ratio_percent * 1.7 +
        row.back_ratio_percent * 1.3 +
        row.empty_spaces * 3 +
        row.back_products * 2 +
        priorityWeight(priority) * 12 +
        issueWeight(issue) * 4;

      return {
        id: row.id,
        store: row.store_name,
        shelf: row.shelf_name,
        category: row.category,
        status: statusOf(row),
        priority,
        action: actionFor(row),
        issue,
        recommendation: actionFor(row),
        compliance,
        fillRate: getFillRate(row),
        emptyRatio: row.empty_ratio_percent,
        backRatio: row.back_ratio_percent,
        profitability: compliance,
        emptySpaces: row.empty_spaces,
        backProducts: row.back_products,
        lastAudit: row.audit_date,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function buildCategories(rows: AnalysisRow[]): CategoryFocus[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    buckets.set(row.category, [...(buckets.get(row.category) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .map(([category, items]) => ({
      category,
      actions: items.filter((item) => priorityFor(item) !== 'Faible').length,
      avgProfitability: average(items.map((item) => getComplianceScore(item))),
      emptySpaces: items.reduce((sum, item) => sum + item.empty_spaces, 0),
      backProducts: items.reduce((sum, item) => sum + item.back_products, 0),
    }))
    .sort((a, b) => b.actions - a.actions || a.avgProfitability - b.avgProfitability)
    .slice(0, 5);
}

function buildTimeline(rows: AnalysisRow[], maxPoints = 7): TimelinePoint[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    const key = dayKey(row.audit_date);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-maxPoints)
    .map(([key, items], index, all) => {
      const actions = issueCount(items);
      const previous = index > 0 ? issueCount(all[index - 1][1]) : actions;

      return {
        label: shortDay(key),
        conformity: average(items.map((item) => getComplianceScore(item))),
        actions,
        corrected: Math.max(0, previous - actions),
      };
    });
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const escape = (value: string | number) => {
    const text = String(value ?? '');
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [headers, ...rows].map((row) => row.map(escape).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.();
}

type Range = 'today' | '7d' | '30d' | 'all';
const RANGE_DAYS: Record<Exclude<Range, 'today' | 'all'>, number> = { '7d': 7, '30d': 30 };
const RANGE_LABELS: Record<Range, string> = { today: "Aujourd'hui", '7d': '7 jours', '30d': '30 jours', all: 'Tout' };
const DEFAULT_EMPTY = 10;
const DEFAULT_BACK = 7;

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem('shelfguide-theme-v2');
    return stored === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function scopeByRange(rows: AnalysisRow[], range: Range): AnalysisRow[] {
  if (range === 'today') return rows.filter((row) => isToday(row.audit_date));
  if (range === 'all') return rows;
  const cutoff = Date.now() - RANGE_DAYS[range] * 86400000;
  return rows.filter((row) => new Date(row.audit_date).getTime() >= cutoff);
}

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const r = p.get('range');
  return {
    range: (r === 'today' || r === '7d' || r === '30d' || r === 'all' ? r : 'all') as Range,
    query: p.get('q') ?? '',
    emptyTh: Number(p.get('empty')) || DEFAULT_EMPTY,
    backTh: Number(p.get('back')) || DEFAULT_BACK,
  };
}

function buildQuery(range: Range, query: string, emptyTh: number, backTh: number): string {
  const p = new URLSearchParams();
  if (range !== 'all') p.set('range', range);
  if (query) p.set('q', query);
  if (emptyTh !== DEFAULT_EMPTY) p.set('empty', String(emptyTh));
  if (backTh !== DEFAULT_BACK) p.set('back', String(backTh));
  return p.toString();
}

export default function App() {
  const [rows, setRows] = useState<AnalysisRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function refresh(showLoading = false) {
    try {
      if (showLoading) setLoading(true);
      else setRefreshing(true);
      setError(null);
      const data = await loadAnalyses({
        storeName: dashboardConfig.storeName,
        category: dashboardConfig.category,
        limit: dashboardConfig.limit,
      });
      setRows(data);
      setLastUpdated(new Date());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement Supabase.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      setError('Variables Supabase manquantes.');
      return;
    }

    void refresh(true);

    const intervalId = window.setInterval(() => {
      void refresh();
    }, dashboardConfig.refreshMs);

    const channel = supabaseClient
      ?.channel('shelfguide-chef-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shelfguide_analyses' },
        () => void refresh(),
      )
      .subscribe();

    return () => {
      window.clearInterval(intervalId);
      if (channel) void supabaseClient?.removeChannel(channel);
    };
  }, []);

  const initial = useRef(readParams()).current;
  const [range, setRange] = useState<Range>(initial.range);
  const [query, setQuery] = useState(initial.query);
  const [emptyTh, setEmptyTh] = useState(initial.emptyTh);
  const [backTh, setBackTh] = useState(initial.backTh);
  const [panel, setPanel] = useState<null | 'settings' | 'share'>(null);
  const [copied, setCopied] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [splashProgress, setSplashProgress] = useState(8);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [selectedShelf, setSelectedShelf] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedPriority, setSelectedPriority] = useState<'all' | Priority>('all');
  const [urgentOnly, setUrgentOnly] = useState(false);
  const quickSearchRef = useRef<HTMLInputElement>(null);

  // Splash : barre de progression au premier chargement uniquement
  useEffect(() => {
    if (!showSplash) return;
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const t = (performance.now() - start) / 1400;
      setSplashProgress((p) => Math.max(p, Math.min(92, 8 + t * 84)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const safety = window.setTimeout(() => setShowSplash(false), 2600);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(safety); };
  }, [showSplash]);

  useEffect(() => {
    if (loading || !showSplash) return;
    setSplashProgress(100);
    const id = window.setTimeout(() => setShowSplash(false), 420);
    return () => window.clearTimeout(id);
  }, [loading, showSplash]);

  // Echap ferme les popovers
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPanel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('shelfguide-theme-v2', theme);
    } catch {
      // Storage can be unavailable in restricted embeds.
    }
  }, [theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        quickSearchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rangedRows = useMemo(() => scopeByRange(rows, range), [rows, range]);
  const shelfOptions = useMemo(
    () => Array.from(new Set(rangedRows.map((row) => row.shelf_name).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [rangedRows],
  );
  const categoryOptions = useMemo(
    () => Array.from(new Set(rangedRows.map((row) => row.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [rangedRows],
  );
  const scopedRows = useMemo(() => rangedRows.filter((row) => {
    const priority = priorityFor(row);
    if (selectedShelf !== 'all' && row.shelf_name !== selectedShelf) return false;
    if (selectedCategory !== 'all' && row.category !== selectedCategory) return false;
    if (selectedPriority !== 'all' && priority !== selectedPriority) return false;
    if (urgentOnly && priority !== 'Haute') return false;
    return true;
  }), [rangedRows, selectedShelf, selectedCategory, selectedPriority, urgentOnly]);
  const summary = useMemo(() => summarize(scopedRows), [scopedRows]);
  const actions = useMemo(() => buildActions(scopedRows), [scopedRows]);
  const categories = useMemo(() => buildCategories(scopedRows), [scopedRows]);
  const timeline = useMemo(() => buildTimeline(scopedRows, range === '7d' ? 7 : 14), [scopedRows, range]);
  const latestAudits = useMemo(
    () => [...scopedRows]
      .sort((a, b) => new Date(b.audit_date).getTime() - new Date(a.audit_date).getTime())
      .slice(0, 5),
    [scopedRows],
  );
  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => `${a.shelf} ${a.category} ${a.store} ${a.action}`.toLowerCase().includes(q));
  }, [actions, query]);

  const qs = buildQuery(range, query, emptyTh, backTh);
  const snapshotUrl = `${window.location.origin}${window.location.pathname}${qs ? '?' + qs : ''}`;

  useEffect(() => {
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [qs]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(id);
  }, [copied]);

  function exportCsv() {
    downloadCsv(
      `shelfguide-terrain-actions-${dayKey(new Date().toISOString())}.csv`,
      ['Rayon', 'Categorie', 'Magasin', 'Statut', 'Priorite', 'Probleme', 'Action', 'Vide %', 'Back-side %', 'Score terrain %', 'Facings vides', 'Back produits', 'Dernier audit'],
      actions.map((a) => [
        a.shelf, a.category, a.store, a.status, a.priority, a.issue, a.action,
        Math.round(a.emptyRatio), Math.round(a.backRatio), Math.round(a.profitability),
        a.emptySpaces, a.backProducts, formatDate(a.lastAudit),
      ]),
    );
  }

  function copySnapshot() {
    void navigator.clipboard?.writeText(snapshotUrl).then(() => setCopied(true));
  }

  function exportPdf() {
    generateChefReport({
      perimetre: [dashboardConfig.storeName, dashboardConfig.category].filter(Boolean).join(' / ') || 'Rayon',
      periode: RANGE_LABELS[range],
      summary: {
        avgProfitability: summary.avgProfitability,
        avgEmptyRatio: summary.avgEmptyRatio,
        avgBackRatio: summary.avgBackRatio,
        audits: summary.audits,
        emptySpaces: summary.emptySpaces,
        backProducts: summary.backProducts,
      },
      counts: { actions: actions.length, high: highActions, medium: mediumActions },
      immediate: immediate
        ? { shelf: immediate.shelf, action: immediate.action, emptyRatio: immediate.emptyRatio, backRatio: immediate.backRatio }
        : undefined,
      actions: actions.slice(0, 12).map((a) => ({
        shelf: a.shelf, category: a.category, status: a.status, action: a.action,
        emptyRatio: a.emptyRatio, backRatio: a.backRatio, priority: a.priority,
      })),
      categories: categories.map((c) => ({ category: c.category, actions: c.actions })),
      timeline: timeline.map((t) => ({ label: t.label, conformity: t.conformity })),
      thresholds: { empty: emptyTh, back: backTh },
    });
  }
  const immediate = actions[0];
  const highActions = actions.filter((action) => action.priority === 'Haute').length;
  const mediumActions = actions.filter((action) => action.priority === 'Moyenne').length;
  const analysedToday = actions.filter((action) => isToday(action.lastAudit)).length;
  const openActions = highActions + mediumActions;
  const lastAuditLabel = latestAudits[0] ? formatDate(latestAudits[0].audit_date) : 'N/A';
  const maxActions = Math.max(1, ...timeline.map((point) => point.actions));
  const terrainReady = summary.avgProfitability >= 85 && highActions === 0;
  const alertCount = highActions || openActions;
  const activityItems: ActivityItem[] = [
    immediate
      ? {
          avatar: 'CR',
          title: `${immediate.shelf}: ${immediate.action}`,
          meta: `${immediate.store} - ${formatDate(immediate.lastAudit)}`,
          tone: toneFromPriority(immediate.priority),
        }
      : {
          avatar: 'OK',
          title: 'Aucune urgence terrain detectee',
          meta: 'Maintenir le tour de controle',
          tone: 'success',
        },
    latestAudits[0]
      ? {
          avatar: 'AI',
          title: `${latestAudits[0].shelf_name} audite automatiquement`,
          meta: `${latestAudits[0].category} - ${formatDate(latestAudits[0].audit_date)}`,
          tone: toneFromStatus(latestAudits[0].status),
        }
      : {
          avatar: 'AI',
          title: 'En attente du prochain audit',
          meta: 'Supabase live actif',
          tone: 'primary',
        },
    {
      avatar: 'HQ',
      title: `${openActions} actions terrain ouvertes`,
      meta: `${analysedToday} analyses traitees aujourd'hui`,
      tone: openActions > 0 ? 'warning' : 'success',
    },
  ];

  const hasActiveFilters =
    query.trim().length > 0 ||
    selectedShelf !== 'all' ||
    selectedCategory !== 'all' ||
    selectedPriority !== 'all' ||
    urgentOnly;

  function resetFilters() {
    setQuery('');
    setSelectedShelf('all');
    setSelectedCategory('all');
    setSelectedPriority('all');
    setUrgentOnly(false);
  }

  return (
    <>
      {showSplash ? (
        <Splash brand="ShelfGuide" sub={dashboardConfig.networkLabel} progress={splashProgress} onSkip={() => setShowSplash(false)} />
      ) : null}
      <main className="app-frame">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">CR</div>
          <div>
            <strong>ShelfGuide Terrain</strong>
            <span>Chef de rayon</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="Navigation dashboard">
          <a className="active" href="#overview">Tour terrain</a>
          <a href="#actions">Actions</a>
          <a href="#categories">Categories</a>
          <a href="#audits">Audits</a>
          <a href="#timeline">Evolution</a>
        </nav>

        <div className={`sync-card ${error ? 'offline' : 'online'}`}>
          <span className="sync-dot" />
          <strong>{error ? 'Connexion a verifier' : refreshing ? 'Synchronisation' : 'Supabase live'}</strong>
          <small>{lastUpdated ? formatDate(lastUpdated.toISOString()) : 'En attente'}</small>
        </div>
      </aside>

      <section className="workspace">
        <header className="page-header" id="overview">
          <div>
            <p className="eyebrow">ShelfGuide terrain</p>
            <h1>Dashboard Chef de Rayon</h1>
            <p className="subtitle">Priorisez les corrections, suivez le remplissage et validez les actions terrain.</p>
          </div>
          <div className="header-actions">
            <label className="quick-search" aria-label="Recherche rapide">
              <span>Search</span>
              <input
                ref={quickSearchRef}
                type="search"
                placeholder="Rayon, action..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <kbd>Ctrl K</kbd>
            </label>
            <div className="seg" role="group" aria-label="Periode d'analyse">
              {(['today', '7d', '30d', 'all'] as Range[]).map((r) => (
                <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>{RANGE_LABELS[r]}</button>
              ))}
            </div>
            <div className="tool-group">
              <button className="tool-btn notify-btn" title="Notifications terrain" aria-label={`${alertCount} notifications terrain`}>
                <span className="notify-dot" aria-hidden="true" />
                {alertCount}
              </button>
              <button className="tool-btn" onClick={() => setPanel(panel === 'settings' ? null : 'settings')} aria-label="Reglages des seuils d'alerte" title="Reglages des seuils d'alerte">⚙</button>
              <button className="tool-btn" onClick={exportCsv} disabled={rows.length === 0} title="Exporter les actions en CSV">CSV</button>
              <button className="tool-btn" onClick={exportPdf} disabled={rows.length === 0} title="Generer un rapport PDF professionnel">PDF</button>
              <button className="tool-btn" onClick={toggleFullscreen} aria-label="Plein ecran" title="Mode presentation plein ecran">⛶</button>
              <button className="tool-btn" onClick={() => setPanel(panel === 'share' ? null : 'share')} aria-label="Partager / QR code" title="Partager / QR code">⤴</button>
              <button className="tool-btn theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Changer le theme" title="Changer le theme">
                {theme === 'dark' ? 'Light' : 'Dark'}
              </button>
            </div>
            <button className="refresh" onClick={() => void refresh()} disabled={loading || !isSupabaseConfigured}>
              Actualiser
            </button>

            {panel ? <div className="popover-backdrop" onClick={() => setPanel(null)} /> : null}
            {panel === 'settings' ? (
              <div className="popover">
                <h3>Seuils d'alerte</h3>
                <label className="field">
                  <span>Vide critique <b>{emptyTh}%</b></span>
                  <input type="range" min={3} max={30} value={emptyTh} onChange={(e) => setEmptyTh(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Back-side critique <b>{backTh}%</b></span>
                  <input type="range" min={2} max={20} value={backTh} onChange={(e) => setBackTh(Number(e.target.value))} />
                </label>
                <button className="ghost-btn" onClick={() => { setEmptyTh(DEFAULT_EMPTY); setBackTh(DEFAULT_BACK); }}>Reinitialiser</button>
              </div>
            ) : null}
            {panel === 'share' ? (
              <div className="popover share">
                <h3>Partager cette vue</h3>
                <p>Scannez pour ouvrir sur mobile (filtres inclus)</p>
                <div className="qr"><QRCodeSVG value={snapshotUrl} size={148} bgColor="#ffffff" fgColor="#111111" level="M" /></div>
                <div className="share-url">
                  <input readOnly value={snapshotUrl} onFocus={(e) => e.currentTarget.select()} />
                  <button onClick={copySnapshot}>{copied ? 'Copie !' : 'Copier'}</button>
                </div>
              </div>
            ) : null}
          </div>
        </header>

        {error ? <ErrorNotice message={error} onRetry={() => void refresh(true)} /> : null}
        {loading ? <DashboardSkeleton label="Chargement des analyses terrain..." /> : null}

        {!loading && rows.length === 0 && !error ? (
          <EmptyState
            title="Aucun audit trouve pour cette periode"
            detail="Les donnees Supabase sont connectees, mais aucun audit ne correspond encore a ce perimetre terrain."
            actionLabel="Reinitialiser les filtres"
            onAction={resetFilters}
          />
        ) : null}

        {rows.length > 0 ? (
          <>
            <ActionHeroCard immediate={immediate} terrainReady={terrainReady} />

            <section className="metric-grid field-kpi-grid">
              <MetricCard label="Score terrain" value={pct(summary.avgProfitability)} detail="Conformite terrain" tone="success" variant="primary" />
              <MetricCard
                label="Actions ouvertes"
                value={String(openActions)}
                detail={highActions > 0 ? 'A traiter maintenant' : 'Rayons propres'}
                tone={highActions > 0 ? 'danger' : 'success'}
                pulse={highActions > 0}
                spark={timeline.map((point) => point.actions)}
                variant="risk"
              />
              <MetricCard label="Zones vides detectees" value={String(summary.emptySpaces)} detail={`${pct(summary.avgEmptyRatio)} moyen`} tone="warning" spark={timeline.map((point) => 100 - point.conformity)} variant="operational" />
              <MetricCard label="Produits mal orientes" value={String(summary.backProducts)} detail={`${pct(summary.avgBackRatio)} back-side moyen`} variant="operational" />
              <MetricCard label="Dernier audit realise" value={lastAuditLabel} detail={`${analysedToday} analyses aujourd'hui`} variant="operational" />
            </section>

            <TerrainFilterBar
              shelves={shelfOptions}
              categories={categoryOptions}
              selectedShelf={selectedShelf}
              selectedCategory={selectedCategory}
              selectedPriority={selectedPriority}
              urgentOnly={urgentOnly}
              onShelf={setSelectedShelf}
              onCategory={setSelectedCategory}
              onPriority={setSelectedPriority}
              onUrgent={setUrgentOnly}
              active={hasActiveFilters}
              onReset={resetFilters}
            />

            <section className="content-grid">
              <section className="panel table-panel" id="actions">
                <div className="panel-head">
                  <PanelTitle eyebrow="Mes priorites aujourd'hui" title="Taches terrain a traiter" />
                  <input
                    className="search"
                    type="search"
                    placeholder="Rechercher un rayon, action..."
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <ActionTable actions={filteredActions.slice(0, 12)} emptyTh={emptyTh} backTh={backTh} onReset={resetFilters} />
              </section>

              <section className="panel action-center-panel">
                <PanelTitle eyebrow="Tour du jour" title="Ordre de passage recommande" />
                <ActionCenter
                  items={[
                    ['Verifier maintenant', immediate?.shelf ?? 'Rayons stables'],
                    ['Equipe', analysedToday > 0 ? `${analysedToday} audits deja lus` : 'Lancer le premier controle'],
                    ['Validation', openActions > 0 ? 'Relancer audit apres correction' : 'Maintenir le rythme'],
                  ]}
                />
              </section>

              <section className="panel activity-panel">
                <PanelTitle eyebrow="Activite terrain" title="Ce qui vient de bouger" />
                <ActivityFeed items={activityItems} />
              </section>

              <section className="panel decisions-panel">
                <PanelTitle eyebrow="Analyse rayon" title="Etat et tendance" />
                <DecisionStack
                  items={[
                    ['Commencer par', immediate?.shelf ?? 'Aucun rayon'],
                    ['Action', immediate?.action ?? 'Controle rapide'],
                    ['Ruptures visibles', String(summary.emptySpaces)],
                    ['Mal orientes', String(summary.backProducts)],
                  ]}
                />
                <FieldStatusDonut actions={actions} />
              </section>

              <section className="panel alerts-panel" id="categories">
                <PanelTitle eyebrow="Categories" title="Zones sensibles" />
                <CategoryList categories={categories} />
              </section>

              <section className="panel recommendations-panel">
                <PanelTitle eyebrow="Recommandations terrain" title="Actions concretes" />
                <TerrainRecommendationList immediate={immediate} openActions={openActions} />
              </section>

              <section className="panel audits-panel" id="audits">
                <PanelTitle eyebrow="Derniers audits du rayon" title="Analyses recentes" />
                <AuditCardList rows={latestAudits} />
              </section>

              <section className="panel timeline-panel" id="timeline">
                <PanelTitle eyebrow="Evolution" title="Conformite et corrections terrain" />
                <Timeline points={timeline} maxActions={maxActions} />
              </section>
            </section>
          </>
        ) : null}
      </section>
      </main>
    </>
  );
}

function Splash({ brand, sub, progress, onSkip }: { brand: string; sub: string; progress: number; onSkip: () => void }) {
  return (
    <div className="splash" onClick={onSkip} role="button" tabIndex={0} aria-label="Passer l'introduction">
      <div className="splash-inner">
        <div className="splash-mark">{brand}</div>
        <p className="splash-sub">{sub}</p>
        <div className="splash-bar"><i style={{ width: `${progress}%` }} /></div>
        <span className="splash-hint">Chargement des analyses…</span>
      </div>
    </div>
  );
}

function DashboardSkeleton({ label }: { label: string }) {
  return (
    <section className="skeleton-shell" aria-label={label}>
      <span>{label}</span>
      <div className="skeleton-grid">
        {Array.from({ length: 7 }).map((_, index) => <i key={index} />)}
      </div>
    </section>
  );
}

function EmptyState({
  title,
  detail,
  actionLabel,
  onAction,
  compact = false,
}: {
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`} role="status">
      <div className="empty-illustration" aria-hidden="true">
        <span />
        <i />
      </div>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {actionLabel && onAction ? (
        <button className="ghost-btn reset-btn" type="button" onClick={onAction}>{actionLabel}</button>
      ) : null}
    </div>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="notice danger error-notice" role="alert">
      <div>
        <strong>Impossible de charger les analyses</strong>
        <p>{message}</p>
      </div>
      <button className="ghost-btn reset-btn" type="button" onClick={onRetry}>Reessayer</button>
    </div>
  );
}

function ActionHeroCard({ immediate, terrainReady }: { immediate?: ActionRow; terrainReady: boolean }) {
  if (!immediate) {
    return (
      <section className="action-hero-card empty-action-hero" aria-label="Action prioritaire">
        <div className="hero-alert-dot success" aria-hidden="true" />
        <div>
          <span className="hero-eyebrow">Action prioritaire</span>
          <h2>Aucune action urgente sur cette periode.</h2>
          <p>Les rayons visibles sont stables. Maintenir le tour de controle et relancer un audit si le facing change.</p>
        </div>
        <StatusBadge tone={terrainReady ? 'success' : 'primary'} label={terrainReady ? 'Terrain propre' : 'Controle'} />
      </section>
    );
  }

  const tone = toneFromPriority(immediate.priority);

  return (
    <section className={`action-hero-card hero-${tone}`} aria-label="Action prioritaire">
      <div className={`hero-alert-dot ${tone}`} aria-hidden="true" />
      <div className="hero-main">
        <div className="hero-topline">
          <span className="hero-eyebrow">Action prioritaire</span>
          <StatusBadge tone={tone} label={`Priorite ${immediate.priority.toLowerCase()}`} />
        </div>
        <h2>{immediate.shelf}</h2>
        <p className="hero-meta">{immediate.category} - {formatDate(immediate.lastAudit)}</p>
        <strong>{immediate.issue} detectee</strong>
        <p>{immediate.recommendation}</p>
      </div>
      <div className="hero-metrics" aria-label="Indicateurs action prioritaire">
        <span><b>{pct(immediate.emptyRatio)}</b> vide</span>
        <span><b>{pct(immediate.backRatio)}</b> back-side</span>
        <span><b>{pct(immediate.compliance)}</b> score</span>
      </div>
      <div className="hero-cta">A traiter maintenant</div>
    </section>
  );
}

function BusinessBand({
  ruptureCostDaily,
  recovered,
  hoursSaved,
  boost,
  onBoost,
  location,
}: {
  ruptureCostDaily: number;
  recovered: number;
  hoursSaved: number;
  boost: number;
  onBoost: (value: number) => void;
  location: string;
}) {
  return (
    <section className="business-band" aria-label="Valorisation business">
      <article className="biz-card">
        <span className="biz-label">Cout estime des ruptures</span>
        <strong className="biz-value">{formatMAD(ruptureCostDaily)}</strong>
        <small>CA potentiel perdu / jour · {location}</small>
      </article>

      <article className="biz-card biz-sim">
        <div className="biz-sim-head">
          <span className="biz-label">Et si +{boost} pts de conformite ?</span>
          <span className="est-badge">estimation</span>
        </div>
        <strong className="biz-value accent">{formatMAD(recovered)}</strong>
        <small>CA recuperable / jour (simulation)</small>
        <input
          className="biz-slider"
          type="range"
          min={0}
          max={20}
          value={boost}
          onChange={(event) => onBoost(Number(event.target.value))}
          aria-label="Gain de conformite simule en points"
        />
      </article>

      <article className="biz-card">
        <span className="biz-label">Temps gagne vs audit manuel</span>
        <strong className="biz-value"><CountUp value={formatHours(hoursSaved)} /></strong>
        <small>economise sur la periode analysee</small>
      </article>
    </section>
  );
}

function CountUp({ value }: { value: string }) {
  const match = value.match(/^(\D*)(-?\d+(?:[.,]\d+)?)(.*)$/);
  const target = match ? parseFloat(match[2].replace(',', '.')) : 0;
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(0);

  useEffect(() => {
    if (!match) {
      setDisplay(value);
      return;
    }
    const prefix = match[1];
    const suffix = match[3];
    const decimals = /[.,]/.test(match[2]) ? match[2].split(/[.,]/)[1]?.length ?? 0 : 0;
    const from = fromRef.current;
    fromRef.current = target;
    const duration = 900;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (target - from) * eased;
      setDisplay(`${prefix}${current.toFixed(decimals)}${suffix}`);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{display}</>;
}

function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}

function Sparkline({ values }: { values: number[] }) {
  const clean = values.filter((value) => Number.isFinite(value));
  const series = clean.length >= 2
    ? clean
    : clean.length === 1
      ? [clean[0] * 0.86, clean[0], clean[0] * 0.94]
      : [18, 34, 26, 42];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = Math.max(1, max - min);
  const points = series
    .map((value, index) => {
      const x = (index / (series.length - 1)) * 100;
      const y = 30 - ((value - min) / range) * 24;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg className="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone = 'primary',
  pulse = false,
  sub,
  spark,
  variant = 'operational',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: Tone;
  pulse?: boolean;
  sub?: string;
  spark?: number[];
  variant?: 'primary' | 'risk' | 'operational' | 'progress' | 'insight';
}) {
  const cleanSpark = spark?.filter((value) => Number.isFinite(value));
  const showSpark = cleanSpark && cleanSpark.length >= 2;

  return (
    <article className={`metric-card metric-${variant} ${tone}${pulse ? ' pulse' : ''}`}>
      <span>{label}{pulse ? <i className="live-dot" aria-hidden="true" /> : null}</span>
      <strong><CountUp value={value} /></strong>
      <small>{detail}</small>
      {sub ? <small className="metric-sub">{sub}</small> : null}
      {showSpark ? <Sparkline values={cleanSpark} /> : null}
    </article>
  );
}

function TerrainFilterBar({
  shelves,
  categories,
  selectedShelf,
  selectedCategory,
  selectedPriority,
  urgentOnly,
  onShelf,
  onCategory,
  onPriority,
  onUrgent,
  active,
  onReset,
}: {
  shelves: string[];
  categories: string[];
  selectedShelf: string;
  selectedCategory: string;
  selectedPriority: 'all' | Priority;
  urgentOnly: boolean;
  onShelf: (value: string) => void;
  onCategory: (value: string) => void;
  onPriority: (value: 'all' | Priority) => void;
  onUrgent: (value: boolean) => void;
  active: boolean;
  onReset: () => void;
}) {
  return (
    <section className="filter-bar" aria-label="Filtres terrain">
      <label>
        <span>Rayon</span>
        <select value={selectedShelf} onChange={(event) => onShelf(event.target.value)}>
          <option value="all">Tous les rayons</option>
          {shelves.map((shelf) => <option key={shelf} value={shelf}>{shelf}</option>)}
        </select>
      </label>
      <label>
        <span>Categorie</span>
        <select value={selectedCategory} onChange={(event) => onCategory(event.target.value)}>
          <option value="all">Toutes categories</option>
          {categories.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
      </label>
      <label>
        <span>Priorite</span>
        <select value={selectedPriority} onChange={(event) => onPriority(event.target.value as 'all' | Priority)}>
          <option value="all">Toutes priorites</option>
          <option value="Haute">Haute</option>
          <option value="Moyenne">Moyenne</option>
          <option value="Faible">Faible</option>
        </select>
      </label>
      <label className="check-filter">
        <input type="checkbox" checked={urgentOnly} onChange={(event) => onUrgent(event.target.checked)} />
        <span>Actions urgentes</span>
      </label>
      {active ? (
        <button className="filter-reset" type="button" onClick={onReset}>
          Reset filtres
        </button>
      ) : null}
    </section>
  );
}

function PanelTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="panel-title">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
    </div>
  );
}

function RatioCell({ value, tone }: { value: number; tone: Tone }) {
  return (
    <div className="ratio-cell">
      <span>{pct(value)}</span>
      <div className={`ratio-track ${tone}`}>
        <i style={{ width: `${clamp(value)}%` }} />
      </div>
    </div>
  );
}

function ActionTable({ actions, emptyTh, backTh, onReset }: { actions: ActionRow[]; emptyTh: number; backTh: number; onReset: () => void }) {
  if (actions.length === 0) {
    return (
      <EmptyState
        compact
        title="Aucune tache terrain"
        detail="Aucune ligne ne correspond a la recherche actuelle."
        actionLabel="Reset filtres"
        onAction={onReset}
      />
    );
  }

  return (
    <div className="action-card-list">
      {actions.map((action) => (
        <article className={`task-action-card row-${toneFromPriority(action.priority)}`} key={action.id}>
          <div className="task-head">
            <StatusBadge tone={toneFromPriority(action.priority)} label={action.priority} />
            <span>{formatDate(action.lastAudit)}</span>
          </div>
          <div className="task-body">
            <div>
              <strong>{action.shelf}</strong>
              <small>{action.category} - {action.store}</small>
            </div>
            <p>{action.issue}</p>
            <em>{action.recommendation}</em>
          </div>
          <div className="task-chips">
            <span className={action.emptyRatio >= emptyTh ? 'danger' : action.emptyRatio >= emptyTh * 0.7 ? 'warning' : 'success'}>{pct(action.emptyRatio)} vide</span>
            <span className={action.backRatio >= backTh ? 'warning' : 'success'}>{pct(action.backRatio)} back-side</span>
            <span>{pct(action.compliance)} score</span>
            <StatusBadge tone={toneFromStatus(action.status)} label={action.status} />
          </div>
        </article>
      ))}
    </div>
  );
}

function FieldStatusDonut({ actions }: { actions: ActionRow[] }) {
  const counts = {
    bon: actions.filter((action) => action.status === 'Bon').length,
    moyen: actions.filter((action) => action.status === 'Moyen').length,
    critique: actions.filter((action) => action.status === 'Critique').length,
  };
  const total = Math.max(1, counts.bon + counts.moyen + counts.critique);
  const good = (counts.bon / total) * 100;
  const medium = (counts.moyen / total) * 100;
  const critical = (counts.critique / total) * 100;

  return (
    <div className="status-donut-card" aria-label="Repartition des statuts terrain">
      <div
        className="status-donut"
        style={{
          '--good': `${good}%`,
          '--medium': `${good + medium}%`,
          '--critical': `${good + medium + critical}%`,
        } as CSSProperties}
      >
        <strong>{actions.length}</strong>
        <span>rayons</span>
      </div>
      <div className="donut-legend">
        <span><i className="success-dot" /> Bon {counts.bon}</span>
        <span><i className="warning-dot" /> Moyen {counts.moyen}</span>
        <span><i className="danger-dot" /> Critique {counts.critique}</span>
      </div>
    </div>
  );
}

function DecisionStack({ items }: { items: [string, string][] }) {
  return (
    <div className="decision-stack">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div className="activity-feed">
      {items.map((item) => (
        <div className="activity-item" key={`${item.avatar}-${item.title}`}>
          <span className={`activity-avatar ${item.tone}`}>{item.avatar}</span>
          <div>
            <strong>{item.title}</strong>
            <small>{item.meta}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function ActionCenter({ items }: { items: [string, string][] }) {
  return (
    <div className="action-center">
      {items.map(([label, value], index) => (
        <div key={label} className="action-center-row">
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div>
            <small>{label}</small>
            <strong>{value}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}

function CategoryList({ categories }: { categories: CategoryFocus[] }) {
  if (categories.length === 0) return <p className="muted">Aucune categorie sensible detectee.</p>;

  return (
    <div className="recurring-list">
      {categories.map((category, index) => (
        <div key={category.category}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{category.category}</strong>
            <small>{category.emptySpaces} vides - {category.backProducts} back-side</small>
          </div>
          <em>{category.actions} actions</em>
        </div>
      ))}
    </div>
  );
}

function TerrainRecommendationList({ immediate, openActions }: { immediate?: ActionRow; openActions: number }) {
  const items = [
    immediate ? `${immediate.action} sur ${immediate.shelf}.` : 'Maintenir un controle rapide du rayon.',
    'Verifier le stock reserve avant de modifier le facing.',
    'Corriger les produits mal orientes en front de rayon.',
    openActions > 0 ? 'Relancer un audit apres correction pour valider le rayon.' : 'Planifier le prochain audit de routine.',
  ];

  return (
    <div className="recommendation-list">
      {items.map((item, index) => (
        <div key={item} className="recommendation-item">
          <span>{String(index + 1).padStart(2, '0')}</span>
          <p>{item}</p>
        </div>
      ))}
    </div>
  );
}

function AuditCardList({ rows }: { rows: AnalysisRow[] }) {
  if (rows.length === 0) return <p className="muted">Aucune analyse recente disponible.</p>;

  return (
    <div className="audit-card-grid">
      {rows.map((row) => {
        const status = statusOf(row);
        return (
          <article className="audit-card" key={row.id}>
            <div className="audit-thumb" aria-hidden="true">SG</div>
            <div>
              <strong>{row.shelf_name}</strong>
              <small>{formatDate(row.audit_date)} - {row.category}</small>
            </div>
            <div className="audit-card-footer">
              <span>{pct(getComplianceScore(row))}</span>
              <StatusBadge tone={toneFromStatus(status)} label={status} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Timeline({ points, maxActions }: { points: TimelinePoint[]; maxActions: number }) {
  const [active, setActive] = useState<number | null>(null);
  if (points.length < 2) {
    return (
      <EmptyState
        compact
        title="Pas encore assez d'historique"
        detail="Il faut au moins deux dates d'audit pour afficher une evolution fiable."
      />
    );
  }

  const W = 720;
  const H = 205;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const baseY = padT + innerH;

  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const x = (i: number) => padL + stepX * i;
  const yConf = (v: number) => padT + innerH * (1 - clamp(v, 0, 100) / 100);
  const ySec = (v: number) => padT + innerH * (1 - clamp(v / maxActions, 0, 1));

  const confPoints = points.map((p, i) => [x(i), yConf(p.conformity)] as const);
  const secPoints = points.map((p, i) => [x(i), ySec(p.actions)] as const);

  const toPath = (pts: readonly (readonly [number, number])[]) =>
    pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' ');

  const confLine = toPath(confPoints);
  const areaPath = `${confLine} L${x(points.length - 1).toFixed(1)} ${baseY} L${padL} ${baseY} Z`;
  const secLine = toPath(secPoints);
  const gridValues = [0, 25, 50, 75, 100];
  const hovered = active !== null ? points[active] : null;

  return (
    <div className="timeline">
      <div className="timeline-legend">
        <span><i className="legend-compliance" /> Conformite</span>
        <span><i className="legend-anomaly" /> Actions</span>
      </div>

      <div className="chart">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Evolution de la conformite et des actions"
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(17, 191, 210, .18)" />
              <stop offset="100%" stopColor="rgba(17, 191, 210, 0)" />
            </linearGradient>
            <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#11bfd2" />
              <stop offset="100%" stopColor="#078da0" />
            </linearGradient>
          </defs>

          {gridValues.map((g) => {
            const gy = yConf(g);
            return (
              <g key={g}>
                <line className="grid-line" x1={padL} y1={gy} x2={W - padR} y2={gy} />
                <text className="y-label" x={padL - 8} y={gy + 3}>{g}</text>
              </g>
            );
          })}

          <path className="area" d={areaPath} fill="url(#areaFill)" />
          <path className="line anomaly" d={secLine} />
          <path className="line compliance" d={confLine} />

          {confPoints.map((pt, i) => (
            <circle
              key={i}
              className="dot"
              cx={pt[0]}
              cy={pt[1]}
              r={active === i ? 0 : 4}
              style={{ animationDelay: `${0.9 + i * 0.08}s` }}
            />
          ))}

          {hovered ? (
            <g>
              <line className="cursor-line" x1={x(active!)} y1={padT} x2={x(active!)} y2={baseY} />
              <circle className="cursor-dot" cx={x(active!)} cy={yConf(hovered.conformity)} r={5.5} />
            </g>
          ) : null}

          {points.map((p, i) =>
            i % Math.ceil(points.length / 7) === 0 || i === points.length - 1 ? (
              <text key={p.label} className="x-label" x={x(i)} y={H - 8}>{p.label}</text>
            ) : null,
          )}

          {points.map((_, i) => (
            <rect
              key={`hit-${i}`}
              className="hit"
              x={x(i) - (stepX || innerW) / 2}
              y={padT}
              width={stepX || innerW}
              height={innerH}
              onMouseEnter={() => setActive(i)}
            />
          ))}
        </svg>

        {hovered ? (
          <div
            className="chart-tooltip"
            style={{ left: `${(x(active!) / W) * 100}%`, top: `${(yConf(hovered.conformity) / H) * 100}%` }}
          >
            <b>{hovered.label}</b>
            <div className="tt-row">
              <span><i style={{ background: '#11bfd2' }} />Conformite</span>
              <strong>{pct(hovered.conformity)}</strong>
            </div>
            <div className="tt-row">
              <span><i style={{ background: '#159b68' }} />Actions</span>
              <strong>{hovered.actions}</strong>
            </div>
            <div className="tt-row">
              <span>Corrigees</span>
              <strong>{hovered.corrected}</strong>
            </div>
          </div>
        ) : null}
      </div>

      {points.length <= 8 ? (
        <div className="chart-foot" style={{ gridTemplateColumns: `repeat(${points.length}, 1fr)` }}>
          {points.map((p) => (
            <small key={p.label}>{pct(p.conformity)} · {p.corrected} corr.</small>
          ))}
        </div>
      ) : null}
    </div>
  );
}

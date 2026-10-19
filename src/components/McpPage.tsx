import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './McpPage.css';

interface McpStatus {
  server_running: boolean;
  port: number;
  edufine_enabled: boolean;
  edufine_running: boolean;
}

interface EdufineStats {
  total_docs: number;
  last_detected_at: string | null;
  watch_dir: string;
}

interface ClaudeConfigResult {
  path: string;
  already_configured: boolean;
}

interface BriefingStatus {
  enabled: boolean;
  provider: 'claude' | 'codex';
  model: string | null;
  agent_installed: boolean;
  agent_path: string | null;
  claude_installed: boolean;
  claude_path: string | null;
  codex_installed: boolean;
  codex_path: string | null;
  authed: boolean;
  running: boolean;
  last_run_at: string | null;
  last_new_count: number;
  last_error: string | null;
  last_seen_id: number;
  docs_enabled: boolean;
  edufine_enabled: boolean;
  docs_last_seen_id: number;
}

interface BriefingRunResult {
  ran: boolean;
  new_count: number;
  skipped: number;
  error: string | null;
  reason: string | null;
}

interface BriefingModelOption {
  id: string;
  label: string;
  description: string;
  is_default: boolean;
}

interface ActivityEntry {
  at: string;
  source: 'messages' | 'docs';
  title: string;
  registered: { title: string; date: string | null }[];
  skipped_dedup: number;
  skipped_invalid: number;
  error: string | null;
}

interface BackfillDoc {
  id: number;
  title: string;
  doc_no: string | null;
  detected_at: string;
  registered: number;
}

type BackfillStatus = 'new' | 'duplicate' | 'past' | 'invalid';

interface BackfillPreviewItem {
  index: number;
  title: string;
  date: string | null;
  source_label: string;
  detail: string | null;
  status: BackfillStatus;
}

interface BackfillPreview {
  preview_id: number;
  source: 'messages' | 'docs';
  scanned: number;
  skipped_docs: number;
  items: BackfillPreviewItem[];
  duration_ms: number;
  raw_result: string | null;
}

const BACKFILL_STATUS_LABEL: Record<BackfillStatus, string> = {
  new: '새 일정',
  duplicate: '이미 있음',
  past: '지난 기한',
  invalid: '날짜 없음',
};

const BACKFILL_COUNTS = [10, 20, 30, 50];
const BACKFILL_MAX_DOCS = 20;

type Tab = 'auto' | 'external' | 'diag';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function describeRun(r: BriefingRunResult): string {
  if (r.error) return `오류: ${r.error}`;
  if (!r.ran) return r.reason || '실행하지 않았습니다.';
  return `완료 · 신규 ${r.new_count}건${r.skipped ? ` (건너뜀 ${r.skipped})` : ''}`;
}

// 일정 날짜("YYYY-MM-DD" 또는 "YYYY-MM-DDTHH:MM:SS+09:00") → "10월 31일 (금) 16:30".
function formatScheduleDate(s: string | null): string {
  if (!s || s.length < 10) return '';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return s;
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  const time = s.length >= 16 && s[10] === 'T' ? ` ${s.slice(11, 16)}` : '';
  return `${m}월 ${d}일 (${wd})${time}`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return '오늘';
  if (d.toDateString() === yesterday.toDateString()) return '어제';
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function groupByDay(entries: ActivityEntry[]): { label: string; entries: ActivityEntry[] }[] {
  const groups: { label: string; entries: ActivityEntry[] }[] = [];
  for (const e of entries) {
    const label = dayLabel(e.at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(e);
    else groups.push({ label, entries: [e] });
  }
  return groups;
}

const CONFIG_JSON = `{
  "mcpServers": {
    "hypercool": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3737/mcp"]
    }
  }
}`;

// ── 인라인 아이콘(이모지 대체, 단색 stroke) ──────────────────────────────
const svgProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const IconMessage = () => (
  <svg width="18" height="18" {...svgProps}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
);
const IconDoc = () => (
  <svg width="18" height="18" {...svgProps}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /></svg>
);
const IconWarn = () => (
  <svg width="16" height="16" {...svgProps}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
);

interface PrereqRow {
  key: string;
  ready: boolean;
  title: string;
  purpose: string;
  fix?: ReactNode;
}

// 외부 AI 탭의 준비 상태: 칩(완료/필요) 한 줄 + 미충족 항목의 해결 안내.
function ReadyBlock({ items }: { items: PrereqRow[] }) {
  const unmet = items.filter(i => !i.ready);
  return (
    <div className="mcp-ready">
      <div className="mcp-ready-chips">
        <span className="mcp-ready-label">준비</span>
        {items.map(it => (
          <span
            key={it.key}
            className={`mcp-chip ${it.ready ? 'mcp-chip--ok' : 'mcp-chip--todo'}`}
            title={it.purpose}
          >
            <span className="mcp-chip-dot" />
            {it.title}
          </span>
        ))}
      </div>
      {unmet.map(it => (
        <div key={it.key} className="mcp-ready-fix">
          <span className="mcp-warn-icon"><IconWarn /></span>
          <span><strong>{it.title}</strong> — {it.fix}</span>
        </div>
      ))}
    </div>
  );
}

// 활동 피드 1건.
function ActivityRow({ entry, onShowDiag }: { entry: ActivityEntry; onShowDiag: () => void }) {
  const skipped = [
    entry.skipped_dedup ? `중복 ${entry.skipped_dedup}건` : '',
    entry.skipped_invalid ? `해당 없음 ${entry.skipped_invalid}건` : '',
  ].filter(Boolean).join(' · ');
  const badge = entry.error
    ? { cls: 'ai-badge--error', text: '오류' }
    : entry.source === 'docs'
      ? { cls: 'ai-badge--doc', text: '공문' }
      : { cls: 'ai-badge--msg', text: '메시지' };

  return (
    <li className="ai-entry">
      <span className="ai-entry-time">{formatClock(entry.at)}</span>
      <div className="ai-entry-body">
        <div className="ai-entry-head">
          <span className={`ai-badge ${badge.cls}`}>{badge.text}</span>
          <span className="ai-entry-title">{entry.title}</span>
        </div>
        {entry.registered.map((r, i) => (
          <div key={i} className="ai-entry-item">
            <span className={`ai-dot ${entry.source === 'docs' ? 'ai-dot--doc' : ''}`} />
            {r.title}{r.date ? ` · ${formatScheduleDate(r.date)}` : ''}
          </div>
        ))}
        {entry.error ? (
          <>
            <div className="ai-entry-muted ai-entry-error">{entry.error.slice(0, 160)}</div>
            <button className="ai-link" onClick={onShowDiag}>진단 탭에서 보기</button>
          </>
        ) : entry.registered.length === 0 ? (
          <div className="ai-entry-muted">
            {entry.source === 'docs' ? '기한 있는 조치 없음' : '등록할 일정 없음'}
            {skipped ? ` · ${skipped} 건너뜀` : ''}
          </div>
        ) : skipped ? (
          <div className="ai-entry-muted">{skipped} 건너뜀</div>
        ) : null}
      </div>
    </li>
  );
}

export const McpPage = () => {
  const [tab, setTab] = useState<Tab>('auto');
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [coolStatus, setCoolStatus] = useState<{ udb_configured: boolean; search_db_count: number } | null>(null);
  const [edufineDocCount, setEdufineDocCount] = useState(0);
  const [edufineToggling, setEdufineToggling] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [nodeInstalled, setNodeInstalled] = useState<boolean | null>(null);
  const [autoSetupState, setAutoSetupState] = useState<'idle' | 'loading' | 'success' | 'already' | 'error'>('idle');
  const [autoSetupTitle, setAutoSetupTitle] = useState('');
  const [autoSetupPath, setAutoSetupPath] = useState('');
  const [autoSetupError, setAutoSetupError] = useState('');
  const [briefing, setBriefing] = useState<BriefingStatus | null>(null);
  const [briefingToggling, setBriefingToggling] = useState(false);
  const [docsToggling, setDocsToggling] = useState(false);
  const [briefingRunning, setBriefingRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [bfSource, setBfSource] = useState<'messages' | 'docs'>('messages');
  const [bfCount, setBfCount] = useState(10);
  const [bfDocs, setBfDocs] = useState<BackfillDoc[]>([]);
  const [bfDocSel, setBfDocSel] = useState<Set<number>>(new Set());
  const [bfRunning, setBfRunning] = useState(false);
  const [bfError, setBfError] = useState<string | null>(null);
  const [bfPreview, setBfPreview] = useState<BackfillPreview | null>(null);
  const [bfSel, setBfSel] = useState<Set<number>>(new Set());
  const [bfApplying, setBfApplying] = useState(false);
  const [bfResult, setBfResult] = useState<string | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [agentModels, setAgentModels] = useState<BriefingModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const loadActivity = useCallback(() => {
    invoke<ActivityEntry[]>('get_briefing_activity', { limit: 50 }).then(setActivity).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, st, b, cool] = await Promise.all([
        invoke<McpStatus>('get_mcp_status'),
        invoke<EdufineStats>('get_edufine_stats'),
        invoke<BriefingStatus>('get_briefing_agent_status'),
        invoke<{ udb_configured: boolean; search_db_count: number }>('get_coolmessenger_status'),
      ]);
      setStatus(s);
      setEdufineDocCount(st.total_docs);
      setBriefing(b);
      setCoolStatus(cool);
    } catch (e) {
      console.error('MCP 상태 로드 실패:', e);
    }
  }, []);

  useEffect(() => {
    load();
    loadActivity();
    invoke<boolean>('check_node_installed').then(setNodeInstalled).catch(() => setNodeInstalled(false));
  }, [load, loadActivity]);

  // 선택한 CLI 가 노출하는 모델 목록(Claude: initialize 응답, Codex: app-server model/list).
  useEffect(() => {
    if (!briefing) return;
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    invoke<BriefingModelOption[]>('get_briefing_agent_models', { provider: briefing.provider })
      .then(models => {
        if (!cancelled) setAgentModels(models);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setAgentModels([]);
          setModelsError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => { cancelled = true; };
  }, [briefing?.provider, briefing?.agent_path]);

  // 자동 실행/완료 시 백엔드가 emit → 상태와 활동 피드 갱신.
  useEffect(() => {
    const unlisten = listen('briefing-status', () => {
      invoke<BriefingStatus>('get_briefing_agent_status').then(setBriefing).catch(() => {});
      loadActivity();
    });
    return () => { void unlisten.then(u => u()); };
  }, [loadActivity]);

  const toggleBriefing = async () => {
    if (!briefing || briefingToggling || (!briefing.agent_installed && !briefing.enabled)) return;
    setBriefingToggling(true);
    try {
      await invoke('set_briefing_agent_enabled', { enabled: !briefing.enabled });
      const s = await invoke<BriefingStatus>('get_briefing_agent_status');
      setBriefing(s);
    } catch (e) {
      console.error('브리핑 토글 실패:', e);
    } finally {
      setBriefingToggling(false);
    }
  };

  // "공문" 분석 대상: 켜면 백엔드가 에듀파인 공문 감시기도 함께 켠다.
  const toggleDocs = async () => {
    if (!briefing || docsToggling) return;
    setDocsToggling(true);
    try {
      await invoke('set_briefing_docs_enabled', { enabled: !briefing.docs_enabled });
      await load();
    } catch (e) {
      console.error('공문 분석 토글 실패:', e);
    } finally {
      setDocsToggling(false);
    }
  };

  const runBriefingNow = async () => {
    if (briefingRunning || bfRunning || !briefing?.agent_installed) return;
    setBriefingRunning(true);
    setRunResult(null);
    try {
      const r = await invoke<BriefingRunResult>('run_briefing_agent_now');
      setRunResult(describeRun(r));
      const s = await invoke<BriefingStatus>('get_briefing_agent_status');
      setBriefing(s);
      loadActivity();
    } catch (e: unknown) {
      setRunResult(`오류: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBriefingRunning(false);
    }
  };

  // 소급 대상 공문 목록은 진단 탭을 열 때 갱신.
  const loadBackfillDocs = useCallback(() => {
    invoke<BackfillDoc[]>('list_backfill_docs', { limit: 30 }).then(setBfDocs).catch(() => setBfDocs([]));
  }, []);

  useEffect(() => {
    if (tab === 'diag') loadBackfillDocs();
  }, [tab, loadBackfillDocs]);

  const toggleBfDoc = (id: number) => {
    setBfDocSel(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < BACKFILL_MAX_DOCS) next.add(id);
      return next;
    });
  };

  const toggleBfItem = (index: number) => {
    setBfSel(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // 소급 미리보기: AI 로 분석만 하고 등록하지 않는다. 새 일정 후보는 기본 선택.
  const runBackfillPreview = async () => {
    if (bfRunning || briefingRunning || !briefing?.agent_installed) return;
    setBfRunning(true);
    setBfError(null);
    setBfPreview(null);
    setBfResult(null);
    try {
      const r = await invoke<BackfillPreview>('preview_backfill', {
        source: bfSource,
        count: bfSource === 'messages' ? bfCount : null,
        docIds: bfSource === 'docs' ? [...bfDocSel] : null,
      });
      setBfPreview(r);
      setBfSel(new Set(r.items.filter(i => i.status === 'new').map(i => i.index)));
    } catch (e: unknown) {
      setBfError(e instanceof Error ? e.message : String(e));
    } finally {
      setBfRunning(false);
    }
  };

  const applyBackfill = async () => {
    if (!bfPreview || bfApplying || bfSel.size === 0) return;
    setBfApplying(true);
    setBfError(null);
    try {
      const r = await invoke<{ new_count: number; skipped: number }>('apply_backfill', {
        previewId: bfPreview.preview_id,
        indices: [...bfSel],
      });
      setBfResult(`달력에 ${r.new_count}건 등록${r.skipped ? ` · ${r.skipped}건 건너뜀` : ''}`);
      setBfPreview(null);
      setBfSel(new Set());
      loadActivity();
      loadBackfillDocs();
    } catch (e: unknown) {
      setBfError(e instanceof Error ? e.message : String(e));
    } finally {
      setBfApplying(false);
    }
  };

  const saveAgentConfig = async (provider: 'claude' | 'codex', model: string) => {
    if (configSaving || briefingRunning || bfRunning) return;
    setConfigSaving(true);
    setConfigError(null);
    try {
      await invoke('set_briefing_agent_config', { provider, model: model.trim() || null });
      const next = await invoke<BriefingStatus>('get_briefing_agent_status');
      setBriefing(next);
    } catch (e: unknown) {
      setConfigError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfigSaving(false);
    }
  };

  const toggleEdufine = async () => {
    if (!status || edufineToggling) return;
    setEdufineToggling(true);
    try {
      await invoke('toggle_edufine_mcp', { enabled: !status.edufine_enabled });
      await load();
    } catch (e) {
      console.error('에듀파인 MCP 토글 실패:', e);
    } finally {
      setEdufineToggling(false);
    }
  };

  const copyConfig = () => {
    navigator.clipboard.writeText(CONFIG_JSON);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  const copyPath = () => {
    navigator.clipboard.writeText('%LOCALAPPDATA%\\Packages');
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const runAutoSetup = async () => {
    setAutoSetupState('loading');
    setAutoSetupTitle(''); setAutoSetupPath(''); setAutoSetupError('');
    try {
      const result = await invoke<ClaudeConfigResult>('setup_claude_mcp');
      setAutoSetupPath(result.path);
      if (result.already_configured) {
        setAutoSetupState('already');
        setAutoSetupTitle('이미 설정되어 있습니다.');
      } else {
        setAutoSetupState('success');
        setAutoSetupTitle('설정 완료! Claude를 재시작하세요.');
      }
    } catch (e: unknown) {
      setAutoSetupState('error');
      setAutoSetupError(e instanceof Error ? e.message : String(e));
    }
  };

  const agentName = briefing?.provider === 'codex' ? 'Codex' : 'Claude Code';
  const autoPrereqs: PrereqRow[] = [
    {
      key: 'udb',
      ready: !!coolStatus?.udb_configured,
      title: '쿨메신저 연결',
      purpose: coolStatus ? `메시지 ${coolStatus.search_db_count.toLocaleString()}건 색인됨` : '받은 메시지를 읽어옵니다.',
      fix: <>쿨메신저에 로그인해 메시지를 한 번 확인한 뒤 HyperCool을 재시작하세요. ‘메시지 분류’ 화면의 ‘파일 선택’으로 <code>.udb</code> 파일을 직접 지정할 수도 있습니다.</>,
    },
    {
      key: 'agent',
      ready: !!briefing?.agent_installed,
      title: `${agentName} 설치`,
      purpose: '메시지를 읽어 일정을 뽑아내는 로컬 AI입니다.',
      fix: briefing?.provider === 'codex'
        ? <>터미널에서 <code>npm i -g @openai/codex</code>로 설치한 뒤 앱을 재시작하세요.</>
        : <><strong>https://claude.ai/download</strong> 또는 <code>npm i -g @anthropic-ai/claude-code</code> 설치 후 앱을 재시작하세요.</>,
    },
    {
      key: 'authed',
      ready: !!briefing?.authed,
      title: '로그인',
      purpose: `${agentName} 로그인 또는 API 키가 필요합니다.`,
      fix: briefing?.provider === 'codex'
        ? <>터미널에서 <code>codex login</code>하거나 <code>OPENAI_API_KEY</code>를 설정하세요.</>
        : <>터미널에서 <code>claude</code>로 로그인하거나 <code>ANTHROPIC_API_KEY</code>를 설정하세요.</>,
    },
  ];

  const queryPrereqs: PrereqRow[] = [
    {
      key: 'mcp',
      ready: !!status?.server_running,
      title: 'MCP 서버',
      purpose: status?.server_running ? `localhost:${status.port} 에서 실행 중` : 'HyperCool의 로컬 연결 서버',
      fix: <>HyperCool을 재시작하면 자동으로 실행됩니다.</>,
    },
    {
      key: 'node',
      ready: nodeInstalled === true,
      title: 'Node.js 설치',
      purpose: '외부 AI가 접속할 때 쓰는 도구(mcp-remote)에 필요합니다.',
      fix: <><strong>https://nodejs.org/ko/download</strong> 에서 설치 후 앱을 재시작하세요.</>,
    },
  ];

  const busy = configSaving || briefingRunning || bfRunning;
  const currentModel = briefing?.model ?? '';
  const defaultModel = agentModels.find(m => m.is_default);
  const modelKnown = !currentModel || agentModels.some(m => m.id === currentModel);

  return (
    <div className="mcp-page ai-page">
      <div className="ai-topbar">
        <h2>AI 연동</h2>
        <div className="ai-tabs" role="tablist" aria-label="AI 연동">
          {([['auto', '자동 일정화'], ['external', '외부 AI 연결'], ['diag', '진단']] as const).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`ai-tab ${tab === id ? 'ai-tab--active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mcp-sections">
        {/* ══ 자동 일정화: 활동 피드 + 설정 패널 ══ */}
        {tab === 'auto' && (
          <div className="ai-auto">
            <section className="ai-feed" aria-label="활동">
              <div className="ai-feed-head">
                <h3>활동</h3>
                {runResult && (
                  <span className={`mcp-run-result ${runResult.startsWith('오류') ? 'mcp-run-result--error' : ''}`}>
                    {runResult}
                  </span>
                )}
                <button
                  className="ai-run-btn"
                  onClick={runBriefingNow}
                  disabled={busy || !briefing?.agent_installed}
                >
                  {briefingRunning || briefing?.running ? '실행 중…' : '지금 실행'}
                </button>
              </div>

              {activity.length === 0 ? (
                <div className="ai-feed-empty">기록 없음</div>
              ) : (
                groupByDay(activity).map(g => (
                  <div key={g.label} className="ai-day">
                    <div className="ai-day-label">{g.label}</div>
                    <ul className="ai-entries">
                      {g.entries.map((e, i) => (
                        <ActivityRow key={`${e.at}-${i}`} entry={e} onShowDiag={() => setTab('diag')} />
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </section>

            <aside className="ai-side">
              <div className="ai-side-row">
                <span className="ai-side-title">자동 일정화</span>
                <button
                  className={`mcp-toggle ${briefing?.enabled ? 'mcp-toggle--on' : 'mcp-toggle--off'}`}
                  onClick={toggleBriefing}
                  disabled={briefingToggling || (!briefing?.agent_installed && !briefing?.enabled)}
                  aria-pressed={!!briefing?.enabled}
                  aria-label="자동 일정화"
                >
                  <span className="mcp-toggle-knob" />
                </button>
              </div>

              <div className="ai-side-group">
                <h4>분석 대상</h4>
                <label className="ai-check">
                  <input type="checkbox" checked disabled />
                  쿨메신저 메시지
                </label>
                <label className="ai-check">
                  <input
                    type="checkbox"
                    checked={!!briefing?.docs_enabled}
                    onChange={toggleDocs}
                    disabled={docsToggling || !briefing}
                  />
                  에듀파인 공문
                </label>
                {briefing?.docs_enabled && !briefing.edufine_enabled && (
                  <div className="ai-side-warn">공문 저장 꺼짐 · 외부 AI 연결 탭에서 켜기</div>
                )}
              </div>

              <div className="ai-side-group">
                <h4>AI</h4>
                <label className="ai-field">
                  엔진
                  <select
                    value={briefing?.provider ?? 'claude'}
                    onChange={e => void saveAgentConfig(e.target.value as 'claude' | 'codex', '')}
                    disabled={busy}
                  >
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                  </select>
                </label>
                <label className="ai-field">
                  모델
                  <select
                    value={currentModel}
                    onChange={e => briefing && void saveAgentConfig(briefing.provider, e.target.value)}
                    disabled={busy || modelsLoading}
                  >
                    <option value="">
                      {modelsLoading ? '불러오는 중…' : defaultModel ? `기본 (${defaultModel.label})` : '기본'}
                    </option>
                    {!modelKnown && <option value={currentModel}>{currentModel}</option>}
                    {agentModels.map(m => (
                      <option key={m.id} value={m.id} title={m.description}>
                        {m.label}{m.label !== m.id ? ` · ${m.id}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {modelsError && <div className="ai-side-warn">모델 목록 실패: {modelsError}</div>}
                {configError && <div className="ai-side-warn">{configError}</div>}
              </div>

              <div className="ai-side-group">
                <h4>준비</h4>
                {autoPrereqs.map(p => (
                  <div key={p.key} className="ai-ready-item">
                    <span className={`ai-ready ${p.ready ? 'ai-ready--ok' : 'ai-ready--todo'}`} title={p.purpose}>
                      <span className="ai-ready-dot" />
                      {p.title}
                    </span>
                    {!p.ready && <div className="ai-ready-fix">{p.fix}</div>}
                  </div>
                ))}
              </div>
            </aside>
          </div>
        )}

        {/* ══ 외부 AI 연결 (MCP 서버로 데이터 노출) ══ */}
        {tab === 'external' && (
          <div className="mcp-section mcp-feature">
            <div className="mcp-briefing-body">
              <ReadyBlock items={queryPrereqs} />

              <div className="mcp-data-sources">
                <div className="mcp-data-label">AI가 읽을 수 있는 정보 <span>(읽기 전용)</span></div>

                <div className="mcp-data-row">
                  <div className="mcp-section-icon mcp-section-icon--sm mcp-section-icon--msg">
                    <IconMessage />
                  </div>
                  <div className="mcp-section-text">
                    <div className="mcp-section-title">쿨메신저 메시지</div>
                  </div>
                  <span className="mcp-always-on">항상 켜짐</span>
                </div>

                <div className="mcp-data-row">
                  <div className="mcp-section-icon mcp-section-icon--sm mcp-section-icon--doc">
                    <IconDoc />
                  </div>
                  <div className="mcp-section-text">
                    <div className="mcp-section-title">에듀파인 공문</div>
                    <div className="mcp-section-sub">
                      {status?.edufine_enabled ? `공문 ${edufineDocCount}개 저장됨` : '꺼짐'}
                    </div>
                  </div>
                  <button
                    className={`mcp-toggle ${status?.edufine_enabled ? 'mcp-toggle--on' : 'mcp-toggle--off'}`}
                    onClick={toggleEdufine}
                    disabled={edufineToggling}
                    aria-pressed={!!status?.edufine_enabled}
                    aria-label="에듀파인 공문 저장"
                  >
                    <span className="mcp-toggle-knob" />
                  </button>
                </div>
              </div>

              <div className="mcp-help-collapse">
                <button className="mcp-help-toggle" onClick={() => setShowHelp(v => !v)}>
                  <span className="mcp-help-icon">?</span>
                  <div className="mcp-section-text">
                    <div className="mcp-section-title">Claude Desktop 연결 방법</div>
                  </div>
                  <span className="mcp-chevron">{showHelp ? '▲' : '▼'}</span>
                </button>

                {showHelp && (
                  <div className="mcp-help-body">
                    <div className="mcp-auto-setup">
                      <button
                        className={`mcp-auto-setup-btn mcp-auto-setup-btn--${autoSetupState}`}
                        onClick={runAutoSetup}
                        disabled={autoSetupState === 'loading'}
                      >
                        {autoSetupState === 'loading' ? '설정 중...'
                          : autoSetupState === 'success' ? '✓ 설정 완료'
                          : autoSetupState === 'already' ? '✓ 이미 설정됨'
                          : autoSetupState === 'error' ? '다시 시도'
                          : '자동 설정하기'}
                      </button>
                      {(autoSetupTitle || autoSetupError) && (
                        <div className={`mcp-auto-setup-result mcp-auto-setup-result--${autoSetupState === 'error' ? 'error' : 'ok'}`}>
                          {autoSetupTitle && <div className="mcp-auto-setup-result-title">{autoSetupTitle}</div>}
                          {autoSetupPath && <div className="mcp-auto-setup-result-path">{autoSetupPath}</div>}
                          {autoSetupError && <div className="mcp-auto-setup-result-error">{autoSetupError}</div>}
                        </div>
                      )}
                      <div className="mcp-auto-setup-divider">또는 직접 설정하기</div>
                    </div>

                    <div className="mcp-help-steps">
                      <div className="mcp-help-step">
                        <span className="mcp-step-num">1</span>
                        <div>
                          <div className="mcp-step-title">Claude Desktop 설치</div>
                          <div className="mcp-step-desc"><strong>https://claude.ai/download</strong> 에서 Windows 버전을 설치하세요.</div>
                        </div>
                      </div>
                      <div className="mcp-help-step">
                        <span className="mcp-step-num">2</span>
                        <div>
                          <div className="mcp-step-title">설정 파일 찾기</div>
                          <div className="mcp-step-desc">탐색기 주소창에 붙여넣고 Enter:</div>
                          <div className="mcp-code-block">
                            <code>%LOCALAPPDATA%\Packages</code>
                            <button className={`mcp-copy-btn ${copiedPath ? 'copied' : ''}`} onClick={copyPath}>
                              {copiedPath ? '복사됨 ✓' : '복사'}
                            </button>
                          </div>
                          <div className="mcp-step-desc">
                            <code>Claude_</code>로 시작하는 폴더 → <code>LocalCache\Roaming\Claude\claude_desktop_config.json</code>
                          </div>
                        </div>
                      </div>
                      <div className="mcp-help-step">
                        <span className="mcp-step-num">3</span>
                        <div>
                          <div className="mcp-step-title">설정 내용 붙여넣기</div>
                          <div className="mcp-step-desc">파일 전체 내용을 아래로 교체 후 저장:</div>
                          <div className="mcp-code-block mcp-code-block--pre">
                            <pre>{CONFIG_JSON}</pre>
                            <button className={`mcp-copy-btn ${copiedConfig ? 'copied' : ''}`} onClick={copyConfig}>
                              {copiedConfig ? '복사됨 ✓' : '복사'}
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="mcp-help-step">
                        <span className="mcp-step-num">4</span>
                        <div>
                          <div className="mcp-step-title">Claude 재시작</div>
                          <div className="mcp-step-desc">Claude를 완전히 종료 후 재실행하세요.</div>
                        </div>
                      </div>
                    </div>

                    <div className="mcp-examples">
                      <div className="mcp-examples-title">이렇게 물어보세요</div>
                      <div className="mcp-example">"가정통신문 중에 급식비 관련된 거 찾아줘"</div>
                      <div className="mcp-example">"학교에서 온 메시지 최근 10개 보여줘"</div>
                      {status?.edufine_enabled && (
                        <>
                          <div className="mcp-example">"최근 에듀파인 공문 목록 알려줘"</div>
                          <div className="mcp-example">"교육과정 관련 공문 검색해줘"</div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══ 진단: 소급 실행(미리보기 → 선택 반영) + 상태 ══ */}
        {tab === 'diag' && (
          <div className="ai-diag">
            <section className="ai-panel" aria-label="소급 실행">
              <div className="ai-panel-head">
                <h3>소급 실행</h3>
                <div className="ai-seg" role="group" aria-label="소급 대상">
                  {([['messages', '메시지'], ['docs', '공문']] as const).map(([id, label]) => (
                    <button
                      key={id}
                      aria-pressed={bfSource === id}
                      className={`ai-seg-btn ${bfSource === id ? 'ai-seg-btn--on' : ''}`}
                      onClick={() => { setBfSource(id); setBfPreview(null); setBfError(null); setBfResult(null); }}
                      disabled={bfRunning}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {bfSource === 'messages' ? (
                <label className="ai-field ai-field--inline">
                  범위
                  <select value={bfCount} onChange={e => setBfCount(Number(e.target.value))} disabled={bfRunning}>
                    {BACKFILL_COUNTS.map(n => <option key={n} value={n}>최근 {n}개 메시지</option>)}
                  </select>
                </label>
              ) : bfDocs.length === 0 ? (
                <div className="ai-feed-empty">저장된 공문 없음</div>
              ) : (
                <>
                  <div className="ai-doc-tools">
                    <span>{bfDocSel.size}건 선택 · 최대 {BACKFILL_MAX_DOCS}건</span>
                    <button
                      className="ai-link"
                      onClick={() => setBfDocSel(new Set(bfDocs.filter(d => d.doc_no && d.registered === 0).slice(0, BACKFILL_MAX_DOCS).map(d => d.id)))}
                      disabled={bfRunning}
                    >
                      미처리 공문 선택
                    </button>
                    <button className="ai-link" onClick={() => setBfDocSel(new Set())} disabled={bfRunning}>선택 해제</button>
                  </div>
                  <ul className="ai-doc-list">
                    {bfDocs.map(d => (
                      <li key={d.id}>
                        <label className={`ai-doc ${d.doc_no ? '' : 'ai-doc--off'}`}>
                          <input
                            type="checkbox"
                            checked={bfDocSel.has(d.id)}
                            onChange={() => toggleBfDoc(d.id)}
                            disabled={!d.doc_no || bfRunning}
                          />
                          <span className="ai-doc-title">{d.title}</span>
                          <span className="ai-doc-meta">
                            {d.doc_no ?? '붙임·초안'}
                            {d.registered > 0 ? ` · 등록 ${d.registered}건` : ''}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="mcp-run-row">
                <button
                  className="ai-run-btn"
                  onClick={runBackfillPreview}
                  disabled={bfRunning || briefingRunning || !briefing?.agent_installed || (bfSource === 'docs' && bfDocSel.size === 0)}
                >
                  {bfRunning ? '분석 중… (수십 초~수 분)' : '미리보기'}
                </button>
                {bfResult && <span className="mcp-run-result">{bfResult}</span>}
              </div>
              {bfError && <div className="mcp-run-result mcp-run-result--error">{bfError}</div>}

              {bfPreview && (
                <div className="ai-preview">
                  <div className="ai-preview-summary">
                    {bfPreview.source === 'docs' ? `공문 ${bfPreview.scanned}건` : `메시지 ${bfPreview.scanned}건`} 분석
                    {bfPreview.skipped_docs ? ` · 붙임·초안 ${bfPreview.skipped_docs}건 제외` : ''}
                    {' · '}{(bfPreview.duration_ms / 1000).toFixed(1)}초
                    {(Object.keys(BACKFILL_STATUS_LABEL) as BackfillStatus[]).map(st => {
                      const n = bfPreview.items.filter(i => i.status === st).length;
                      return n ? ` · ${BACKFILL_STATUS_LABEL[st]} ${n}` : '';
                    }).join('')}
                  </div>

                  {bfPreview.items.length === 0 ? (
                    <div className="ai-feed-empty">추출된 일정 없음</div>
                  ) : (
                    <ul className="ai-preview-list">
                      {bfPreview.items.map(it => (
                        <li key={it.index}>
                          <label className={`ai-preview-item ${it.status === 'new' ? '' : 'ai-preview-item--off'}`}>
                            <input
                              type="checkbox"
                              checked={bfSel.has(it.index)}
                              onChange={() => toggleBfItem(it.index)}
                              disabled={it.status !== 'new' || bfApplying}
                            />
                            <span className={`ai-status ai-status--${it.status}`}>{BACKFILL_STATUS_LABEL[it.status]}</span>
                            <span className="ai-preview-main">
                              <span className="ai-preview-title">{it.title}</span>
                              <span className="ai-preview-meta">
                                {formatScheduleDate(it.date) || '날짜 없음'} · {it.source_label}
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mcp-run-row">
                    <button className="ai-run-btn" onClick={applyBackfill} disabled={bfApplying || bfSel.size === 0}>
                      {bfApplying ? '반영 중…' : `선택 ${bfSel.size}건 달력에 반영`}
                    </button>
                  </div>

                  {bfPreview.raw_result != null && (
                    <details className="mcp-debug-raw">
                      <summary>AI 응답 원문</summary>
                      <pre>{bfPreview.raw_result || '(빈 응답)'}</pre>
                    </details>
                  )}
                </div>
              )}
            </section>

            <section className="ai-panel ai-panel--side" aria-label="상태">
              <div className="ai-panel-head"><h3>상태</h3></div>
              <dl className="ai-state">
                <dt>검색 DB</dt><dd>{coolStatus ? `메시지 ${coolStatus.search_db_count.toLocaleString()}건` : '—'}</dd>
                <dt>메시지 진행 위치</dt><dd>#{briefing?.last_seen_id ?? 0}</dd>
                <dt>공문 진행 위치</dt><dd>#{briefing?.docs_last_seen_id ?? 0} · 저장 {edufineDocCount}개</dd>
                <dt>{agentName}</dt><dd className="ai-state-path">{briefing?.agent_path ?? '미설치'}</dd>
                <dt>로그인</dt><dd>{briefing?.authed ? '확인됨' : '미확인'}</dd>
                <dt>마지막 오류</dt><dd className={briefing?.last_error ? 'ai-state-error' : ''}>{briefing?.last_error ?? '없음'}</dd>
              </dl>
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

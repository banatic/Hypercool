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
  claude_installed: boolean;
  claude_path: string | null;
  authed: boolean;
  running: boolean;
  last_run_at: string | null;
  last_new_count: number;
  last_error: string | null;
  last_seen_id: number;
}

interface BriefingRunResult {
  ran: boolean;
  new_count: number;
  skipped: number;
  error: string | null;
  reason: string | null;
}

interface BriefingDebugReport {
  claude_installed: boolean;
  claude_path: string | null;
  authed: boolean;
  udb_path: string | null;
  udb_max_id: number | null;
  search_db_exists: boolean;
  search_db_count: number;
  search_db_max_id: number;
  synced_new: number;
  last_seen_id: number;
  since_used: number;
  target_messages: number;
  ran_claude: boolean;
  duration_ms: number;
  claude_is_error: boolean;
  raw_result: string | null;
  raw_stderr_tail: string | null;
  extracted_count: number;
  registered_new: number;
  skipped_dedup: number;
  skipped_invalid: number;
  error: string | null;
  notes: string[];
}

function formatRunTime(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ko-KR', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function describeRun(r: BriefingRunResult): string {
  if (r.error) return `오류: ${r.error}`;
  if (!r.ran) return r.reason || '실행하지 않았습니다.';
  return `완료 · 신규 ${r.new_count}건${r.skipped ? ` (건너뜀 ${r.skipped})` : ''}`;
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
const IconCalendar = () => (
  <svg width="18" height="18" {...svgProps}><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
);
const IconWarn = () => (
  <svg width="16" height="16" {...svgProps}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
);
const IconSparkle = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" /></svg>
);

interface PrereqRow {
  key: string;
  ready: boolean;
  title: string;
  purpose: string;
  fix?: ReactNode;
}

// 기능 카드 안에 들어가는 준비 상태: 칩(완료/필요) 한 줄 + 미충족 항목의 해결 안내.
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

export const McpPage = () => {
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
  const [briefingRunning, setBriefingRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [debugRunning, setDebugRunning] = useState(false);
  const [debugReport, setDebugReport] = useState<BriefingDebugReport | null>(null);
  const [debugError, setDebugError] = useState<string | null>(null);

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
    invoke<boolean>('check_node_installed').then(setNodeInstalled).catch(() => setNodeInstalled(false));
  }, [load]);

  // 브리핑 에이전트 실행 상태 갱신(자동 실행/완료 시 백엔드가 emit).
  useEffect(() => {
    const unlisten = listen('briefing-status', () => {
      invoke<BriefingStatus>('get_briefing_agent_status').then(setBriefing).catch(() => {});
    });
    return () => { void unlisten.then(u => u()); };
  }, []);

  const toggleBriefing = async () => {
    if (!briefing || briefingToggling || !briefing.claude_installed) return;
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

  const runBriefingNow = async () => {
    if (briefingRunning || debugRunning || !briefing?.claude_installed) return;
    setBriefingRunning(true);
    setRunResult(null);
    try {
      const r = await invoke<BriefingRunResult>('run_briefing_agent_now');
      setRunResult(describeRun(r));
      const s = await invoke<BriefingStatus>('get_briefing_agent_status');
      setBriefing(s);
    } catch (e: unknown) {
      setRunResult(`오류: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBriefingRunning(false);
    }
  };

  // 디버그: 검색 DB 동기화 → 최근 10개 메시지로 강제 1회 실행(진행 위치 미변경) → 상세 리포트.
  const runBriefingDebug = async () => {
    if (briefingRunning || debugRunning || !briefing?.claude_installed) return;
    setDebugRunning(true);
    setDebugReport(null);
    setDebugError(null);
    try {
      const r = await invoke<BriefingDebugReport>('run_briefing_agent_debug', { count: 10 });
      setDebugReport(r);
      // 등록된 항목이 생겼을 수 있으니 상태 갱신.
      const s = await invoke<BriefingStatus>('get_briefing_agent_status');
      setBriefing(s);
    } catch (e: unknown) {
      setDebugError(`오류: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDebugRunning(false);
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

  // 카드 1(자동 일정화) 준비 항목.
  const autoPrereqs: PrereqRow[] = [
    {
      key: 'udb',
      ready: !!coolStatus?.udb_configured,
      title: '쿨메신저 연결',
      purpose: coolStatus ? `메시지 ${coolStatus.search_db_count.toLocaleString()}건 색인됨` : '받은 메시지를 읽어옵니다.',
      fix: <>쿨메신저에 로그인해 메시지를 한 번 확인한 뒤 HyperCool을 재시작하세요. ‘메시지 분류’ 화면의 ‘파일 선택’으로 <code>.udb</code> 파일을 직접 지정할 수도 있습니다.</>,
    },
    {
      key: 'claude',
      ready: !!briefing?.claude_installed,
      title: 'Claude Code 설치',
      purpose: '메시지를 읽어 일정을 뽑아내는 로컬 AI입니다.',
      fix: <><strong>https://claude.ai/download</strong> 또는 <code>npm i -g @anthropic-ai/claude-code</code> 설치 후 앱을 재시작하세요.</>,
    },
    {
      key: 'authed',
      ready: !!briefing?.authed,
      title: 'Claude 로그인',
      purpose: 'Claude 구독 로그인 또는 API 키가 필요합니다.',
      fix: <>터미널에서 <code>claude</code> 로 로그인하거나 <code>ANTHROPIC_API_KEY</code> 를 설정하세요.</>,
    },
  ];

  // 카드 2(외부 AI 질문) 준비 항목.
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

  const briefingSub = !briefing?.claude_installed
    ? 'Claude Code CLI 미설치'
    : briefing.enabled
      ? (briefing.last_error
          ? `오류: ${briefing.last_error.slice(0, 40)}`
          : briefing.last_run_at
            ? `마지막 실행: ${formatRunTime(briefing.last_run_at)} · 신규 ${briefing.last_new_count}건`
            : '활성화됨 · 새 메시지 대기 중')
      : '비활성화';

  return (
    <div className="mcp-page">
      <div className="mcp-header">
        <h2>AI 연동</h2>
        <p className="mcp-subtitle">
          쿨메신저·에듀파인 데이터를 AI와 연결합니다. 아래 두 가지를 켜서 쓸 수 있어요.
        </p>
      </div>

      <div className="mcp-sections">
        {/* ══ 기능 1: 새 메시지 자동 일정화 (HyperCool 내부에서 AI 실행) ══ */}
        <div className="mcp-section mcp-feature">
          <div className="mcp-section-header">
            <div className="mcp-section-icon mcp-section-icon--ai">
              <IconCalendar /><span className={`mcp-status-dot ${briefing?.enabled ? 'mcp-status-dot--on' : 'mcp-status-dot--off'}`} />
            </div>
            <div className="mcp-section-text">
              <div className="mcp-section-title">
                새 메시지 자동 일정화<span className="mcp-badge-ai">AI</span>
              </div>
              <div className="mcp-section-sub">{briefingSub}</div>
            </div>
            <button
              className={`mcp-toggle ${briefing?.enabled ? 'mcp-toggle--on' : 'mcp-toggle--off'}`}
              onClick={toggleBriefing}
              disabled={briefingToggling || !briefing?.claude_installed}
            >
              <span className="mcp-toggle-knob" />
            </button>
          </div>

          <div className="mcp-briefing-body">
            <div className="mcp-briefing-desc">
              새 쿨메신저 메시지가 오면 <strong>Claude Code</strong>가 내용·첨부를 읽어 할 일·마감을
              자동으로 추출해 <strong>달력</strong>에 등록합니다. 로컬에서 실행되며 메시지를 <strong>읽기만</strong> 하고,
              쓰기는 내 달력에만 합니다. 새 메시지 감지 후 약 45초 모아 한 번 실행하며, AI가 만든 일정은 보라색으로 표시됩니다.
            </div>

            <ReadyBlock items={autoPrereqs} />

            {briefing?.enabled && (
              <div className="mcp-run-row">
                <button
                  className="mcp-run-btn"
                  onClick={runBriefingNow}
                  disabled={briefingRunning || debugRunning || !briefing.claude_installed}
                >
                  {briefingRunning ? '실행 중…' : '지금 실행'}
                </button>
                {runResult && (
                  <span className={`mcp-run-result ${runResult.startsWith('오류') ? 'mcp-run-result--error' : ''}`}>
                    {runResult}
                  </span>
                )}
              </div>
            )}

            {/* 디버그: 최근 10개로 강제 실행(진행 위치 미변경) + 상세 진단 */}
            {briefing?.claude_installed && (
              <div className="mcp-debug-box">
                <div className="mcp-debug-label">테스트 / 진단</div>
                <div className="mcp-run-row">
                  <button
                    className="mcp-run-btn mcp-run-btn--ghost"
                    onClick={runBriefingDebug}
                    disabled={briefingRunning || debugRunning}
                  >
                    {debugRunning ? '진단 중… (최대 수십 초)' : '최근 10개 메시지로 실행 + 진단'}
                  </button>
                </div>
                <div className="mcp-debug-hint">
                  검색 DB를 먼저 동기화한 뒤 최근 메시지로 동작을 시험합니다. 저장된 진행 위치는 바뀌지 않고, 이미 등록된 일정은 자동 제외됩니다.
                </div>

                {debugError && (
                  <div className="mcp-run-result mcp-run-result--error">{debugError}</div>
                )}

                {debugReport && (
                  <div className="mcp-debug-report">
                    <div className="mcp-debug-summary">
                      추출 {debugReport.extracted_count} · 신규 {debugReport.registered_new} · 중복 {debugReport.skipped_dedup} · 제외 {debugReport.skipped_invalid}
                      {debugReport.ran_claude ? ` · ${(debugReport.duration_ms / 1000).toFixed(1)}초` : ' · claude 미실행'}
                      {debugReport.claude_is_error ? ' · claude 오류' : ''}
                    </div>

                    <div className="mcp-debug-grid">
                      <span>검색DB: {debugReport.search_db_count}건 · 최신 #{debugReport.search_db_max_id}</span>
                      <span>UDB 최신: {debugReport.udb_max_id ?? '—'}</span>
                      <span>이번 동기화 신규: {debugReport.synced_new}건</span>
                      <span>대상: id&gt;{debugReport.since_used} · {debugReport.target_messages}건</span>
                      <span>last_seen: #{debugReport.last_seen_id}</span>
                      <span>인증: {debugReport.authed ? 'OK' : '미확인'}</span>
                    </div>

                    {debugReport.notes.length > 0 && (
                      <ul className="mcp-debug-notes">
                        {debugReport.notes.map((n, i) => <li key={i}>{n}</li>)}
                      </ul>
                    )}

                    {debugReport.error && (
                      <div className="mcp-run-result mcp-run-result--error">{debugReport.error}</div>
                    )}

                    {debugReport.raw_result != null && (
                      <details className="mcp-debug-raw">
                        <summary>claude 응답 원문 (result)</summary>
                        <pre>{debugReport.raw_result || '(빈 응답)'}</pre>
                      </details>
                    )}
                    {debugReport.raw_stderr_tail && (
                      <details className="mcp-debug-raw">
                        <summary>stderr</summary>
                        <pre>{debugReport.raw_stderr_tail}</pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ══ 기능 2: 외부 AI에게 물어보기 (MCP 서버로 데이터 노출) ══ */}
        <div className="mcp-section mcp-feature mcp-section--help">
          <div className="mcp-section-header">
            <div className="mcp-section-icon mcp-section-icon--query">
              <IconSparkle />
            </div>
            <div className="mcp-section-text">
              <div className="mcp-section-title">외부 AI에게 물어보기</div>
              <div className="mcp-section-sub">Claude Desktop 등에서 학교 메시지·공문을 검색·조회</div>
            </div>
          </div>

          <div className="mcp-briefing-body">
            <div className="mcp-briefing-desc">
              HyperCool이 <strong>MCP 서버</strong>로 데이터를 열어주면, Claude Desktop 같은 외부 AI가
              내 쿨메신저 메시지와 에듀파인 공문을 <strong>읽어</strong> 답해줍니다.
            </div>

            <ReadyBlock items={queryPrereqs} />

            {/* 데이터 소스: AI가 읽을 수 있는 정보 */}
            <div className="mcp-data-sources">
              <div className="mcp-data-label">AI가 읽을 수 있는 정보 <span>(읽기 전용)</span></div>

              <div className="mcp-data-row">
                <div className="mcp-section-icon mcp-section-icon--sm mcp-section-icon--msg">
                  <IconMessage />
                </div>
                <div className="mcp-section-text">
                  <div className="mcp-section-title">쿨메신저 메시지</div>
                  <div className="mcp-section-sub">받은 메시지·첨부를 검색·조회</div>
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
                    {status?.edufine_enabled ? `공문 ${edufineDocCount}개 저장됨` : '비활성화'}
                  </div>
                </div>
                <button
                  className={`mcp-toggle ${status?.edufine_enabled ? 'mcp-toggle--on' : 'mcp-toggle--off'}`}
                  onClick={toggleEdufine}
                  disabled={edufineToggling}
                >
                  <span className="mcp-toggle-knob" />
                </button>
              </div>
              {!status?.edufine_enabled && (
                <div className="mcp-edufine-hint">
                  활성화하면 에듀파인에서 공문을 열 때 자동으로 저장됩니다.
                </div>
              )}
            </div>

            {/* Claude Desktop 연결 방법 (접이식) */}
            <div className="mcp-help-collapse">
              <button className="mcp-help-toggle" onClick={() => setShowHelp(v => !v)}>
                <span className="mcp-help-icon">?</span>
                <div className="mcp-section-text">
                  <div className="mcp-section-title">Claude Desktop 연결 방법</div>
                  <div className="mcp-section-sub">한 번만 설정하면 됩니다</div>
                </div>
                <span className="mcp-chevron">{showHelp ? '▲' : '▼'}</span>
              </button>

              {showHelp && (
                <div className="mcp-help-body">
                  <div className="mcp-auto-setup">
                    <div className="mcp-auto-setup-label">아래 버튼으로 설정 파일을 자동으로 업데이트합니다.</div>
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
                        <div className="mcp-step-desc">Claude를 완전히 종료 후 재실행하세요. 이제 쿨메신저 메시지와 에듀파인 공문을 바로 물어볼 수 있습니다!</div>
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
      </div>
    </div>
  );
};

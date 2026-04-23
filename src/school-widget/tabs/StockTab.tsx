import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface StockQuote {
  symbol: string;
  short_name: string;
  regular_market_price: number;
  regular_market_change_percent: number;
  pre_market_price: number | null;
  pre_market_change_percent: number | null;
  post_market_price: number | null;
  post_market_change_percent: number | null;
  market_state: string;
  currency: string;
}

const STORAGE_KEY = 'stockWatchlist';
const DEFAULT_SYMBOLS = ['AAPL', 'TSLA', 'NVDA'];
const REFRESH_INTERVAL_MS = 60_000;

const MARKET_STATE_LABELS: Record<string, string> = {
  PRE: '프리마켓',
  REGULAR: '정규장',
  POST: '장후',
  POSTPOST: '장후',
  CLOSED: '마감',
  PREPRE: '프리마켓',
};

const MARKET_STATE_COLORS: Record<string, string> = {
  PRE: 'rgba(255,200,50,0.3)',
  PREPRE: 'rgba(255,200,50,0.3)',
  REGULAR: 'rgba(50,200,100,0.3)',
  POST: 'rgba(100,130,255,0.3)',
  POSTPOST: 'rgba(100,130,255,0.3)',
  CLOSED: 'rgba(80,80,90,0.4)',
};

const MARKET_STATE_TEXT_COLORS: Record<string, string> = {
  PRE: '#ffd060',
  PREPRE: '#ffd060',
  REGULAR: '#5ef08a',
  POST: '#a0b8ff',
  POSTPOST: '#a0b8ff',
  CLOSED: 'rgba(255,255,255,0.4)',
};

function formatPrice(price: number, currency: string): string {
  const sym = currency === 'KRW' ? '₩' : currency === 'JPY' ? '¥' : '$';
  if (currency === 'KRW' || currency === 'JPY') {
    return `${sym}${Math.round(price).toLocaleString('ko-KR')}`;
  }
  return `${sym}${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function pctColor(pct: number): string {
  return pct >= 0 ? '#5ef08a' : '#ff6b6b';
}

export default function StockTab() {
  const [symbols, setSymbols] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : DEFAULT_SYMBOLS;
    } catch {
      return DEFAULT_SYMBOLS;
    }
  });
  const [quotes, setQuotes] = useState<StockQuote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSymbol, setNewSymbol] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchQuotes = useCallback(async (syms: string[]) => {
    if (syms.length === 0) { setQuotes([]); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<StockQuote[]>('get_stock_quotes', { symbols: syms });
      setQuotes(result);
      setLastUpdated(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQuotes(symbols);
    const interval = setInterval(() => fetchQuotes(symbols), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [symbols, fetchQuotes]);

  const saveSymbols = (next: string[]) => {
    setSymbols(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const addSymbol = () => {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym || symbols.includes(sym)) { setNewSymbol(''); return; }
    saveSymbols([...symbols, sym]);
    setNewSymbol('');
  };

  const removeSymbol = (sym: string) => {
    saveSymbols(symbols.filter(s => s !== sym));
    setQuotes(prev => prev.filter(q => q.symbol !== sym));
  };

  const quoteMap = new Map(quotes.map(q => [q.symbol, q]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '8px', gap: '6px', overflow: 'hidden' }}>
      {/* 종목 추가 */}
      <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
        <input
          value={newSymbol}
          onChange={e => setNewSymbol(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') addSymbol(); }}
          placeholder="AAPL · 005930.KS..."
          style={{
            flex: 1, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: '6px', padding: '4px 8px', color: '#fff', fontSize: '12px',
            outline: 'none',
          }}
        />
        <button
          onClick={addSymbol}
          style={{
            background: 'rgba(59,124,247,0.5)', border: '1px solid rgba(59,124,247,0.7)',
            borderRadius: '6px', color: '#fff', padding: '4px 10px', cursor: 'pointer', fontSize: '12px',
          }}
        >
          추가
        </button>
        <button
          onClick={() => fetchQuotes(symbols)}
          disabled={loading}
          title="새로고침"
          style={{
            background: 'rgba(80,80,90,0.5)', border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '6px', color: '#fff', padding: '4px 8px', cursor: 'pointer', fontSize: '13px',
            opacity: loading ? 0.5 : 1,
          }}
        >
          ↻
        </button>
      </div>

      {/* 상태 */}
      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', flexShrink: 0, minHeight: 14 }}>
        {loading && '데이터 불러오는 중...'}
        {!loading && lastUpdated && `최종 갱신: ${lastUpdated.toLocaleTimeString('ko-KR')} · 60초마다 자동 갱신`}
      </div>
      {error && (
        <div style={{
          fontSize: '11px', color: '#ff8080', background: 'rgba(255,80,80,0.1)',
          border: '1px solid rgba(255,80,80,0.3)', borderRadius: '6px', padding: '6px 8px', flexShrink: 0,
        }}>
          ⚠ {error}
        </div>
      )}

      {/* 종목 목록 */}
      <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {symbols.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: '12px', textAlign: 'center', marginTop: 20 }}>
            종목을 추가해보세요
          </div>
        )}
        {symbols.map(sym => {
          const q = quoteMap.get(sym);
          if (!q) {
            return (
              <div key={sym} style={{
                background: 'rgba(40,40,50,0.5)', borderRadius: '8px', padding: '8px 10px',
                border: '1px solid rgba(255,255,255,0.07)', display: 'flex',
                justifyContent: 'space-between', alignItems: 'center', position: 'relative',
              }}>
                <span style={{ fontWeight: 700, fontSize: '13px', opacity: 0.5 }}>{sym}</span>
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)' }}>
                  {loading ? '로딩...' : '데이터 없음'}
                </span>
                <button onClick={() => removeSymbol(sym)} style={removeBtn}>×</button>
              </div>
            );
          }

          const stateLabel = MARKET_STATE_LABELS[q.market_state] ?? q.market_state;
          const stateBg = MARKET_STATE_COLORS[q.market_state] ?? 'rgba(80,80,90,0.4)';
          const stateText = MARKET_STATE_TEXT_COLORS[q.market_state] ?? '#fff';

          return (
            <div key={sym} style={{
              background: 'rgba(40,40,52,0.65)', borderRadius: '8px', padding: '8px 10px',
              border: '1px solid rgba(255,255,255,0.09)', position: 'relative',
            }}>
              <button onClick={() => removeSymbol(sym)} style={removeBtn}>×</button>

              {/* 헤더 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: 3, paddingRight: 16 }}>
                <span style={{ fontWeight: 700, fontSize: '13px' }}>{q.symbol}</span>
                <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.short_name}
                </span>
                <span style={{
                  fontSize: '9px', padding: '1px 5px', borderRadius: '4px',
                  background: stateBg, color: stateText, flexShrink: 0,
                }}>
                  {stateLabel}
                </span>
              </div>

              {/* 정규장 가격 */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px' }}>
                <span style={{ fontSize: '16px', fontWeight: 700 }}>
                  {formatPrice(q.regular_market_price, q.currency)}
                </span>
                <span style={{ fontSize: '12px', fontWeight: 600, color: pctColor(q.regular_market_change_percent) }}>
                  {formatPercent(q.regular_market_change_percent)}
                </span>
              </div>

              {/* 프리/장후 */}
              {(q.pre_market_price !== null || q.post_market_price !== null) && (
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {q.pre_market_price !== null && (
                    <div style={{ fontSize: '10px', color: '#ffd060' }}>
                      🌅 프리마켓&nbsp;
                      <span style={{ fontWeight: 600 }}>{formatPrice(q.pre_market_price, q.currency)}</span>
                      &nbsp;
                      <span style={{ color: pctColor(q.pre_market_change_percent ?? 0) }}>
                        {formatPercent(q.pre_market_change_percent ?? 0)}
                      </span>
                    </div>
                  )}
                  {q.post_market_price !== null && (
                    <div style={{ fontSize: '10px', color: '#a0b8ff' }}>
                      🌙 장후&nbsp;
                      <span style={{ fontWeight: 600 }}>{formatPrice(q.post_market_price, q.currency)}</span>
                      &nbsp;
                      <span style={{ color: pctColor(q.post_market_change_percent ?? 0) }}>
                        {formatPercent(q.post_market_change_percent ?? 0)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.2)', textAlign: 'center', flexShrink: 0 }}>
        미국: CNBC · 한국: 네이버 Finance · 한국 종목은 005930 또는 005930.KS
      </div>
    </div>
  );
}

const removeBtn: React.CSSProperties = {
  position: 'absolute', top: 4, right: 6,
  background: 'none', border: 'none', color: 'rgba(255,255,255,0.25)',
  cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1,
};

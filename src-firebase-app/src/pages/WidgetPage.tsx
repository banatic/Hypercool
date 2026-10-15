import React, { useState } from 'react';
import { Copy, Check, Download, ExternalLink, Link2 } from 'lucide-react';
import { useData } from '../context/DataStore';
import { PageHeader } from '../components/Layout';
import './WidgetPage.css';

const APP_STORE = 'https://apps.apple.com/kr/app/scriptable/id1405459188';
const SCRIPT_NAME = 'HyperCool';

const isApple = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);

export const WidgetPage: React.FC = () => {
  const { user } = useData();
  const [copied, setCopied] = useState<'code' | 'token' | null>(null);

  const refreshToken = user?.refreshToken ?? '';
  const connectUrl = `scriptable:///run/${encodeURIComponent(SCRIPT_NAME)}?token=${encodeURIComponent(refreshToken)}`;

  const copy = async (kind: 'code' | 'token') => {
    try {
      const text = kind === 'token' ? refreshToken : await (await fetch('/hypercool-widget.js')).text();
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1800);
    } catch (e) {
      console.error('copy failed', e);
      alert('복사하지 못했습니다.');
    }
  };

  return (
    <div className="page widget">
      <PageHeader title="iOS 위젯" description={isApple() ? undefined : 'iPhone에서 이 페이지를 열어 진행하세요.'} />

      <ol className="steps panel">
        <li className="step">
          <div className="step-num">1</div>
          <div className="step-body">
            <h2>Scriptable 설치</h2>
            <div className="step-actions">
              <a className="btn" href={APP_STORE} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={15} aria-hidden="true" />
                App Store
              </a>
            </div>
          </div>
        </li>

        <li className="step">
          <div className="step-num">2</div>
          <div className="step-body">
            <h2>스크립트 추가</h2>
            <p>파일을 열면 Scriptable이 <b>{SCRIPT_NAME}</b> 이름으로 가져옵니다. 직접 만들 때는 코드를 붙여넣고 이름을 <b>{SCRIPT_NAME}</b>으로 저장하세요.</p>
            <div className="step-actions">
              <a className="btn" href="/HyperCool.scriptable" download="HyperCool.scriptable">
                <Download size={15} aria-hidden="true" />
                스크립트 파일
              </a>
              <button type="button" className="btn ghost" onClick={() => copy('code')}>
                {copied === 'code' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                {copied === 'code' ? '복사됨' : '코드 복사'}
              </button>
            </div>
          </div>
        </li>

        <li className="step">
          <div className="step-num">3</div>
          <div className="step-body">
            <h2>계정 연결</h2>
            <p>이 버튼은 내 계정의 읽기 토큰을 iPhone의 Scriptable에만 저장합니다. 토큰을 다른 사람과 공유하지 마세요.</p>
            <div className="step-actions">
              <a className={`btn primary${refreshToken ? '' : ' disabled'}`} href={refreshToken ? connectUrl : undefined} aria-disabled={!refreshToken}>
                <Link2 size={15} aria-hidden="true" />
                위젯 연결
              </a>
              <button type="button" className="btn ghost" onClick={() => copy('token')} disabled={!refreshToken}>
                {copied === 'token' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                {copied === 'token' ? '복사됨' : '토큰 복사'}
              </button>
            </div>
          </div>
        </li>

        <li className="step">
          <div className="step-num">4</div>
          <div className="step-body">
            <h2>홈 화면에 추가</h2>
            <p>홈 화면을 길게 눌러 Scriptable 위젯을 추가하고, 위젯 설정의 Script에서 <b>{SCRIPT_NAME}</b>을 고릅니다. 소형·중형·대형 모두 지원합니다.</p>
          </div>
        </li>
      </ol>
    </div>
  );
};

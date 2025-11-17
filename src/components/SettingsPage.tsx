import React, { useState } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { PageHeader } from './PageHeader';

interface SettingsPageProps {
  udbPath: string;
  setUdbPath: (path: string) => void;
  pickUdb: () => void;
  saveToRegistry: (key: string, value: string) => Promise<void>;
  classTimes: string[];
  setClassTimes: (times: string[]) => void;
  uiScale: number;
  setUiScale: (scale: number) => void;
  onHideToTray: () => void;
}

const REG_KEY_UDB = 'UdbPath';
const REG_KEY_CLASS_TIMES = 'ClassTimes';
const REG_KEY_UI_SCALE = 'UIScale';

export const SettingsPage: React.FC<SettingsPageProps> = ({
  udbPath,
  setUdbPath,
  pickUdb,
  saveToRegistry,
  classTimes,
  setClassTimes,
  uiScale,
  setUiScale,
  onHideToTray,
}) => {
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ version: string; date: string; body: string } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);

  const addClassTime = () => {
    const newTime = '0900-0950';
    setClassTimes([...classTimes, newTime]);
  };

  const removeClassTime = (index: number) => {
    setClassTimes(classTimes.filter((_, i) => i !== index));
  };

  const updateClassTime = (index: number, value: string) => {
    const newTimes = [...classTimes];
    newTimes[index] = value;
    setClassTimes(newTimes);
  };

  const saveClassTimes = () => {
    saveToRegistry(REG_KEY_CLASS_TIMES, JSON.stringify(classTimes));
  };

  const formatTimeDisplay = (timeStr: string) => {
    // HHMM-HHMM 형식을 HH:MM - HH:MM로 변환
    const match = timeStr.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (match) {
      return `${match[1]}:${match[2]} - ${match[3]}:${match[4]}`;
    }
    return timeStr;
  };

  const checkForUpdates = async () => {
    setIsCheckingUpdate(true);
    setUpdateInfo(null);
    setUpdateProgress(null);
    try {
      const update = await check();
      if (update) {
        console.log(
          `found update ${update.version} from ${update.date} with notes ${update.body}`
        );
        setUpdateInfo({
          version: update.version,
          date: update.date || '',
          body: update.body || '',
        });
      } else {
        setUpdateInfo(null);
        alert('최신 버전입니다.');
      }
    } catch (error) {
      console.error('업데이트 확인 중 오류:', error);
      alert('업데이트 확인 중 오류가 발생했습니다.');
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const downloadAndInstallUpdate = async () => {
    if (!updateInfo) return;
    
    setIsInstalling(true);
    setUpdateProgress({ downloaded: 0, total: 0 });
    
    try {
      const update = await check();
      if (!update) {
        alert('업데이트를 찾을 수 없습니다.');
        setIsInstalling(false);
        return;
      }

      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0;
            setUpdateProgress({ downloaded: 0, total: contentLength });
            console.log(`started downloading ${event.data.contentLength ?? 0} bytes`);
            break;
          case 'Progress':
            downloaded += event.data.chunkLength ?? 0;
            setUpdateProgress({ downloaded, total: contentLength });
            console.log(`downloaded ${downloaded} from ${contentLength}`);
            break;
          case 'Finished':
            console.log('download finished');
            break;
        }
      });

      console.log('update installed');
      await relaunch();
    } catch (error) {
      console.error('업데이트 설치 중 오류:', error);
      alert('업데이트 설치 중 오류가 발생했습니다.');
      setIsInstalling(false);
      setUpdateProgress(null);
    }
  };

  return (
    <div className="settings page-content">
      <PageHeader title="설정" />
      <button className="title-x" onClick={onHideToTray} title="트레이로 숨기기">×</button>
      <div className="field">
        <label htmlFor="udbPathInput">UDB 경로</label>
        <div className="row">
          <input id="udbPathInput" type="text" value={udbPath} onChange={(e) => setUdbPath(e.target.value)} placeholder="C:\...\your.udb" />
          <button onClick={pickUdb}>찾기</button>
          <button onClick={() => saveToRegistry(REG_KEY_UDB, udbPath)}>저장</button>
        </div>
      </div>
      <div className="field">
        <label>수업 시간</label>
        <div className="class-times-list">
          {classTimes.map((time, index) => (
            <div key={index} className="class-time-item">
              <input
                type="text"
                value={time}
                onChange={(e) => updateClassTime(index, e.target.value)}
                placeholder="0830-0920"
                pattern="\d{4}-\d{4}"
              />
              <span className="class-time-display">{formatTimeDisplay(time)}</span>
              <button onClick={() => removeClassTime(index)} className="remove-btn">삭제</button>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: '10px' }}>
          <button onClick={addClassTime}>수업 시간 추가</button>
          <button onClick={saveClassTimes}>저장</button>
        </div>
        <div className="field-description">
          수업 시간 동안에는 새로운 메시지가 와도 창이 자동으로 표시되지 않습니다. 형식: HHMM-HHMM (예: 0830-0920)
        </div>
      </div>
      <br /> <br />
      <div className="field">
        <label htmlFor="uiScaleInput">UI 배율</label>
        <div className="row">
          <input 
            id="uiScaleInput" 
            type="range" 
            min="0.5" 
            max="2.0" 
            step="0.1" 
            value={uiScale} 
            onChange={(e) => {
              const newScale = parseFloat(e.target.value);
              setUiScale(newScale);
              saveToRegistry(REG_KEY_UI_SCALE, newScale.toString());
            }}
            style={{ flex: 1 }}
          />
          <span style={{ minWidth: '60px', textAlign: 'right' }}>{(uiScale * 100).toFixed(0)}%</span>
        </div>
        <div className="field-description">
          전체 UI의 크기를 조정합니다. (50% ~ 200%)
        </div>
      </div>
      <br /> <br />
      <div className="field">
        <label>업데이트</label>
        <div className="row">
          <button 
            onClick={checkForUpdates} 
            disabled={isCheckingUpdate || isInstalling}
          >
            {isCheckingUpdate ? '확인 중...' : '업데이트 확인'}
          </button>
        </div>
        <br />
        {updateInfo && (
          <div style={{ marginTop: '15px', padding: '10px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
            <div style={{ marginBottom: '10px' }}>
              <strong>새 버전 발견:</strong> {updateInfo.version}
            </div>
            <div style={{ marginBottom: '10px', fontSize: '0.9em', color: '#666' }}>
              <strong>날짜:</strong> {updateInfo.date}
            </div>
            {updateInfo.body && (
              <div style={{ marginBottom: '10px', fontSize: '0.9em', color: '#666', whiteSpace: 'pre-wrap' }}>
                <strong>변경 사항:</strong><br />
                {updateInfo.body}
              </div>
            )}
            {updateProgress && (
              <div style={{ marginBottom: '10px' }}>
                <div style={{ marginBottom: '5px', fontSize: '0.9em' }}>
                  다운로드 중: {Math.round((updateProgress.downloaded / updateProgress.total) * 100)}%
                </div>
                <div style={{ width: '100%', height: '20px', backgroundColor: '#e0e0e0', borderRadius: '10px', overflow: 'hidden' }}>
                  <div 
                    style={{ 
                      width: `${(updateProgress.downloaded / updateProgress.total) * 100}%`, 
                      height: '100%', 
                      backgroundColor: '#4CAF50',
                      transition: 'width 0.3s ease'
                    }} 
                  />
                </div>
                <div style={{ fontSize: '0.8em', color: '#666', marginTop: '5px' }}>
                  {Math.round(updateProgress.downloaded / 1024 / 1024 * 100) / 100} MB / {Math.round(updateProgress.total / 1024 / 1024 * 100) / 100} MB
                </div>
              </div>
            )}
            {!isInstalling && (
              <button 
                onClick={downloadAndInstallUpdate}
                disabled={isCheckingUpdate}
                style={{ marginTop: '10px' }}
              >
                업데이트 다운로드 및 설치
              </button>
            )}
            {isInstalling && (
              <div style={{ marginTop: '10px', color: '#666' }}>
                업데이트 설치 중... 설치가 완료되면 앱이 자동으로 재시작됩니다.
              </div>
            )}
          </div>
        )}
        <br /><br />
      </div>
    </div>
  );
};

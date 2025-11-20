import React, { useState, useEffect } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { PageHeader } from './PageHeader';
import { invoke } from '@tauri-apps/api/core';

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
const REG_KEY_AUTO_START = 'AutoStart';
const REG_KEY_AUTO_START_HIDE_MAIN = 'AutoStartHideMain';
const REG_KEY_AUTO_START_CALENDAR = 'AutoStartCalendar';
const REG_KEY_AUTO_START_SCHOOL = 'AutoStartSchool';

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
  const [isLatestVersion, setIsLatestVersion] = useState(false);
  
  // 자동 실행 설정 상태
  const [autoStart, setAutoStart] = useState(false);
  const [autoStartHideMain, setAutoStartHideMain] = useState(false);
  const [autoStartCalendar, setAutoStartCalendar] = useState(false);
  const [autoStartSchool, setAutoStartSchool] = useState(false);
  
  // 설정 불러오기
  useEffect(() => {
    const loadAutoStartSettings = async () => {
      try {
        const autoStartValue = await invoke<string | null>('get_registry_value', { key: REG_KEY_AUTO_START });
        setAutoStart(autoStartValue === 'true');
        
        const hideMainValue = await invoke<string | null>('get_registry_value', { key: REG_KEY_AUTO_START_HIDE_MAIN });
        setAutoStartHideMain(hideMainValue === 'true');
        
        const calendarValue = await invoke<string | null>('get_registry_value', { key: REG_KEY_AUTO_START_CALENDAR });
        setAutoStartCalendar(calendarValue === 'true');
        
        const schoolValue = await invoke<string | null>('get_registry_value', { key: REG_KEY_AUTO_START_SCHOOL });
        setAutoStartSchool(schoolValue === 'true');
      } catch (error) {
        console.error('자동 실행 설정 불러오기 실패:', error);
      }
    };
    loadAutoStartSettings();
  }, []);

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
    setIsLatestVersion(false);
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
        setIsLatestVersion(false);
      } else {
        setUpdateInfo(null);
        setIsLatestVersion(true);
      }
    } catch (error) {
      console.error('업데이트 확인 중 오류:', error);
      setUpdateInfo(null);
      setIsLatestVersion(false);
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
        <div className="row">
          <button onClick={addClassTime}>수업 시간 추가</button>
          <button onClick={saveClassTimes}>저장</button>
        </div>
        <div className="field-description">
          수업 시간 동안에는 새로운 메시지가 와도 창이 자동으로 표시되지 않습니다. 형식: HHMM-HHMM (예: 0830-0920)
        </div>
      </div>

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
          <span className="ui-scale-value">{(uiScale * 100).toFixed(0)}%</span>
        </div>
        <div className="field-description">
          전체 UI의 크기를 조정합니다. (50% ~ 200%)
        </div>
      </div>

      <div className="field">
        <label>자동 실행 설정</label>
        <div className="setting-item">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={async (e) => {
                const value = e.target.checked;
                setAutoStart(value);
                await invoke('set_auto_start', { enabled: value });
                await saveToRegistry(REG_KEY_AUTO_START, value.toString());
              }}
            />
            <span>윈도우 시작 시 자동 실행</span>
          </label>
          <div className="field-description">
            Windows 시작 시 프로그램이 자동으로 실행됩니다.
          </div>
        </div>
        {autoStart && (
          <div className="setting-sub-items">
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoStartHideMain}
                  onChange={async (e) => {
                    const value = e.target.checked;
                    setAutoStartHideMain(value);
                    await saveToRegistry(REG_KEY_AUTO_START_HIDE_MAIN, value.toString());
                  }}
                />
                <span>자동 실행 시 메인 윈도우 숨기기</span>
              </label>
              <div className="field-description">
                자동 실행 시 메인 윈도우를 트레이로 숨깁니다.
              </div>
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoStartCalendar}
                  onChange={async (e) => {
                    const value = e.target.checked;
                    setAutoStartCalendar(value);
                    await saveToRegistry(REG_KEY_AUTO_START_CALENDAR, value.toString());
                  }}
                />
                <span>프로그램 실행 시 달력 위젯 자동 실행</span>
              </label>
            </div>
            <div className="setting-item">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoStartSchool}
                  onChange={async (e) => {
                    const value = e.target.checked;
                    setAutoStartSchool(value);
                    await saveToRegistry(REG_KEY_AUTO_START_SCHOOL, value.toString());
                  }}
                />
                <span>프로그램 실행 시 학교 위젯 자동 실행</span>
              </label>
            </div>
          </div>
        )}
      </div>

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
        {isLatestVersion && (
          <div className="update-status-message update-latest">
            최신 버전입니다.
          </div>
        )}
        {updateInfo && (
          <div className="update-info-box">
            <div className="update-info-header">
              <strong>새 버전 발견:</strong> {updateInfo.version}
            </div>
            {updateInfo.date && (
              <div className="update-info-date">
                <strong>날짜:</strong> {updateInfo.date}
              </div>
            )}
            {updateInfo.body && (
              <div className="update-info-body">
                <strong>변경 사항:</strong>
                <pre>{updateInfo.body}</pre>
              </div>
            )}
            {updateProgress && (
              <div className="update-progress">
                <div className="update-progress-text">
                  다운로드 중: {Math.round((updateProgress.downloaded / updateProgress.total) * 100)}%
                </div>
                <div className="update-progress-bar">
                  <div 
                    className="update-progress-fill"
                    style={{ 
                      width: `${(updateProgress.downloaded / updateProgress.total) * 100}%`
                    }} 
                  />
                </div>
                <div className="update-progress-size">
                  {Math.round(updateProgress.downloaded / 1024 / 1024 * 100) / 100} MB / {Math.round(updateProgress.total / 1024 / 1024 * 100) / 100} MB
                </div>
              </div>
            )}
            {!isInstalling && (
              <button 
                className="update-install-btn"
                onClick={downloadAndInstallUpdate}
                disabled={isCheckingUpdate}
              >
                업데이트 다운로드 및 설치
              </button>
            )}
            {isInstalling && (
              <div className="update-installing">
                업데이트 설치 중... 설치가 완료되면 앱이 자동으로 재시작됩니다.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

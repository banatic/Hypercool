import { CAT_TYPES, CatTypeId, Tab, ALL_TABS, TimetableData, AppinData } from '../types';

interface Props {
  // 위젯
  timetableSource: 'comcigan' | 'appin';
  onTimetableSourceChange: (src: 'comcigan' | 'appin') => void;
  schoolWidgetPinned: boolean;
  onSchoolWidgetPinnedChange: (v: boolean) => void;
  // 탭 표시
  enabledTabs: Tab[];
  onEnabledTabsChange: (tabs: Tab[]) => void;
  // 고양이
  enabledCats: CatTypeId[];
  onEnabledCatsChange: (cats: CatTypeId[]) => void;
  catSize: number;
  onCatSizeReset: () => void;
  // 시간표
  timetableData: TimetableData | null;
  appinData: AppinData | null;
  defaultTeacher: string;
  onDefaultTeacherChange: (v: string) => void;
  // 학년·반
  grade: string;
  onGradeChange: (v: string) => void;
  classNum: string;
  onClassNumChange: (v: string) => void;
  // 학교 정보
  regionCode: string;
  onRegionCodeChange: (v: string) => void;
  schoolCode: string;
  onSchoolCodeChange: (v: string) => void;
  // 저장
  onSave: () => void;
}

const TOGGLEABLE_TABS: Tab[] = ['todo', 'meal', 'timetable', 'attendance', 'points'];

export default function SettingsTab({
  timetableSource, onTimetableSourceChange,
  schoolWidgetPinned, onSchoolWidgetPinnedChange,
  enabledTabs, onEnabledTabsChange,
  enabledCats, onEnabledCatsChange,
  catSize, onCatSizeReset,
  timetableData, appinData,
  defaultTeacher, onDefaultTeacherChange,
  grade, onGradeChange,
  classNum, onClassNumChange,
  regionCode, onRegionCodeChange,
  schoolCode, onSchoolCodeChange,
  onSave,
}: Props) {

  const handleTimetableSourceChange = (src: 'comcigan' | 'appin') => {
    onTimetableSourceChange(src);
    localStorage.setItem('schoolTimetableSource', src);
  };

  const handleTabToggle = (tabId: Tab) => {
    const isEnabled = enabledTabs.includes(tabId);
    const next = isEnabled
      ? enabledTabs.filter(t => t !== tabId)
      : [...enabledTabs, tabId];
    onEnabledTabsChange(next);
    localStorage.setItem('schoolEnabledTabs', JSON.stringify(next));
  };

  const teachers = timetableSource === 'appin'
    ? (appinData?.teachers || [])
    : (timetableData?.teachers || []);

  return (
    <div className="settings-section">

      {/* 위젯 */}
      <div className="settings-card">
        <div className="settings-card-title">위젯</div>
        <div className="settings-row">
          <span className="settings-label">시간표 소스</span>
          <div className="segment-control">
            <button
              className={`segment-btn ${timetableSource === 'comcigan' ? 'active' : ''}`}
              onClick={() => handleTimetableSourceChange('comcigan')}
            >컴시간</button>
            <button
              className={`segment-btn ${timetableSource === 'appin' ? 'active' : ''}`}
              onClick={() => handleTimetableSourceChange('appin')}
            >압핀</button>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">위젯 고정</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={schoolWidgetPinned}
              onChange={(e) => onSchoolWidgetPinnedChange(e.target.checked)}
            />
            <span className="toggle-track"><span className="toggle-thumb" /></span>
          </label>
        </div>
      </div>

      {/* 탭 표시 */}
      <div className="settings-card">
        <div className="settings-card-title">탭 표시</div>
        <div className="settings-row" style={{ alignItems: 'flex-start', paddingTop: '12px', paddingBottom: '12px' }}>
          <span className="settings-label" style={{ paddingTop: '2px' }}>활성 탭</span>
          <div className="cat-chips">
            {TOGGLEABLE_TABS.map(tabId => {
              const tabInfo = ALL_TABS.find(t => t.id === tabId)!;
              const isActive = enabledTabs.includes(tabId);
              return (
                <button
                  key={tabId}
                  className={`cat-chip ${isActive ? 'active' : ''}`}
                  onClick={() => handleTabToggle(tabId)}
                >
                  {tabInfo.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 고양이 */}
      <div className="settings-card">
        <div className="settings-card-title">고양이</div>
        <div className="settings-row" style={{ alignItems: 'flex-start', paddingTop: '12px', paddingBottom: '12px' }}>
          <span className="settings-label" style={{ paddingTop: '2px' }}>종류</span>
          <div className="cat-chips">
            {CAT_TYPES.map(catType => {
              const isActive = enabledCats.includes(catType.id);
              return (
                <button
                  key={catType.id}
                  className={`cat-chip ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    const next = isActive
                      ? enabledCats.filter(id => id !== catType.id)
                      : [...enabledCats, catType.id];
                    onEnabledCatsChange(next);
                    localStorage.setItem('schoolEnabledCats', JSON.stringify(next));
                  }}
                >
                  <span
                    style={{
                      width: '14px', height: '14px',
                      backgroundImage: `url(${new URL(`../../asset/${catType.sprite}`, import.meta.url).href})`,
                      backgroundSize: `56px ${14 * catType.rows}px`,
                      backgroundPosition: '-28px 0',
                      imageRendering: 'pixelated',
                      display: 'inline-block', flexShrink: 0,
                    }}
                  />
                  {catType.name}
                </button>
              );
            })}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">크기</span>
          <span className="settings-value-text">{catSize}px</span>
          <button className="settings-reset-btn" onClick={onCatSizeReset}>초기화</button>
        </div>
      </div>

      {/* 시간표 */}
      <div className="settings-card">
        <div className="settings-card-title">시간표</div>
        <div className="settings-row">
          <span className="settings-label">기본 선생님</span>
          <select
            value={defaultTeacher}
            onChange={(e) => onDefaultTeacherChange(e.target.value)}
            className="settings-select-inline"
          >
            <option value="">없음</option>
            {teachers.map((t: string) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 학년·반 */}
      <div className="settings-card">
        <div className="settings-card-title">학년 · 반</div>
        <div className="settings-row">
          <span className="settings-label">학년</span>
          <input
            type="number"
            value={grade}
            onChange={(e) => onGradeChange(e.target.value)}
            min="1" max="3"
            className="settings-number-input"
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">반</span>
          <input
            type="number"
            value={classNum}
            onChange={(e) => onClassNumChange(e.target.value)}
            min="1" max="20"
            className="settings-number-input"
          />
        </div>
      </div>

      {/* 학교 정보 */}
      <div className="settings-card">
        <div className="settings-card-title">학교 정보</div>
        <div className="settings-row">
          <span className="settings-label">지역 코드</span>
          <input
            type="text"
            value={regionCode}
            onChange={(e) => onRegionCodeChange(e.target.value)}
            placeholder="예: C10"
            className="settings-text-input"
          />
        </div>
        <div className="settings-hint">서울 C10 · 경기 J10 · 부산 B10</div>
        <div className="settings-row">
          <span className="settings-label">학교 코드</span>
          <input
            type="text"
            value={schoolCode}
            onChange={(e) => onSchoolCodeChange(e.target.value)}
            placeholder="예: 7150451"
            className="settings-text-input"
          />
        </div>
        <div className="settings-hint">NEIS 학교 정보 검색에서 확인 가능</div>
      </div>

      <button onClick={onSave} className="save-btn">저장</button>
    </div>
  );
}

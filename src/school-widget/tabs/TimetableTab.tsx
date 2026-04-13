import React from 'react';
import { TimetableData, AppinData, PERIOD_START_TIMES } from '../types';

function getSubjectColor(subjectName: string): string {
  if (!subjectName) return '';
  let hash = 0;
  for (let i = 0; i < subjectName.length; i++) {
    hash = subjectName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsla(${hue}, 45%, 72%, 0.42)`;
}

interface WeekRange {
  mondayDate: Date;
  days: string[];
  weekText: string;
}

interface Props {
  timetableSource: 'comcigan' | 'appin';
  timetableData: TimetableData | null;
  appinData: AppinData | null;
  selectedTeacher: string;
  parsedAppinTeachers: Record<string, Record<string, Record<string, { subject: string; className: string }>>>;
  baseAppinTimetable: Record<number, Record<number, { subject: string; className: string } | null>> | null;
  appinWeekRange: WeekRange;
  onAppinWeekOffsetChange: (fn: (o: number) => number) => void;
  currentNow: Date;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  // teacher search
  teacherSearch: string;
  onTeacherSearchChange: (v: string) => void;
  showTeacherDropdown: boolean;
  onShowTeacherDropdown: (v: boolean) => void;
  filteredTeachers: string[];
  highlightedIndex: number;
  onHighlightedIndexChange: (i: number) => void;
  onTeacherSelect: (t: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  defaultTeacher: string;
  favoriteTeachers: string[];
  onToggleFavorite: (t: string, e?: React.MouseEvent) => void;
  onWheelScroll: (e: React.WheelEvent<HTMLDivElement>) => void;
}

export default function TimetableTab({
  timetableSource, timetableData, appinData, selectedTeacher,
  parsedAppinTeachers, baseAppinTimetable, appinWeekRange,
  onAppinWeekOffsetChange, currentNow, loading, error, onRetry,
  teacherSearch, onTeacherSearchChange, showTeacherDropdown, onShowTeacherDropdown,
  filteredTeachers, highlightedIndex, onHighlightedIndexChange, onTeacherSelect, onKeyDown,
  defaultTeacher, favoriteTeachers, onToggleFavorite, onWheelScroll,
}: Props) {

  const renderGrid = () => {
    if (loading) return <div className="loading">로딩 중...</div>;
    if (error) return (
      <div className="error-message" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '16px' }}>
        <span>시간표를 불러오는데 실패했습니다.</span>
        <button className="refresh-btn-small" onClick={onRetry}>다시 시도</button>
      </div>
    );

    let schedule: any[][][] = [];
    if (timetableSource === 'appin') {
      if (!appinData || !selectedTeacher || !parsedAppinTeachers[selectedTeacher] || !baseAppinTimetable)
        return <div className="error-message">No Data</div>;

      const teacherData = parsedAppinTeachers[selectedTeacher];
      const { mondayDate } = appinWeekRange;

      schedule = Array(8).fill(null).map(() => Array(5).fill(null)) as any;
      for (let dIdx = 0; dIdx < 5; dIdx++) {
        const targetDate = new Date(mondayDate);
        targetDate.setDate(mondayDate.getDate() + dIdx);
        const year = targetDate.getFullYear();
        const month = String(targetDate.getMonth() + 1).padStart(2, '0');
        const day = String(targetDate.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;

        for (let pIdx = 0; pIdx < 7; pIdx++) {
          const pStr = (pIdx + 1).toString();
          const slot = teacherData[dateStr]?.[pStr];
          const baseSlot = baseAppinTimetable[dIdx + 1]?.[pIdx + 1];
          const dateHasData = !!teacherData[dateStr];

          if (slot) {
            const isDiff = !baseSlot || baseSlot.subject !== slot.subject || baseSlot.className !== slot.className;
            schedule[pIdx][dIdx] = [slot.subject, slot.className, isDiff];
          } else if (baseSlot && dateHasData) {
            schedule[pIdx][dIdx] = ['', '', true];
          } else if (baseSlot) {
            schedule[pIdx][dIdx] = [baseSlot.subject, baseSlot.className, false];
          } else {
            schedule[pIdx][dIdx] = null as any;
          }
        }
      }
    } else {
      if (!timetableData || !selectedTeacher) return <div className="error-message">No Data</div>;
      const s = timetableData.timetables[selectedTeacher];
      if (!s) return <div className="error-message">No Schedule for {selectedTeacher}</div>;
      schedule = s as any;
    }

    const days = timetableSource === 'appin' ? appinWeekRange.days : ['월', '화', '수', '목', '금'];
    const periods = [1, 2, 3, 4, 5, 6, 7];

    const now = currentNow;
    const currentDay = now.getDay();
    const isWeekday = currentDay >= 1 && currentDay <= 5;
    const currentTime = now.getHours() * 60 + now.getMinutes();

    const periodTimes = [
      { start: 8 * 60 + 30, end: 9 * 60 + 20 },
      { start: 9 * 60 + 30, end: 10 * 60 + 20 },
      { start: 10 * 60 + 30, end: 11 * 60 + 20 },
      { start: 11 * 60 + 30, end: 12 * 60 + 20 },
      { start: 12 * 60 + 20, end: 13 * 60 + 20 },
      { start: 13 * 60 + 20, end: 14 * 60 + 10 },
      { start: 14 * 60 + 20, end: 15 * 60 + 10 },
      { start: 15 * 60 + 20, end: 16 * 60 + 10 },
    ];

    const getCurrentTimeY = () => {
      if (currentDay < 1 || currentDay > 5) return null;
      for (let i = 0; i < periodTimes.length; i++) {
        const period = periodTimes[i];
        if (currentTime >= period.start && currentTime <= period.end) {
          const progress = (currentTime - period.start) / (period.end - period.start);
          return { rowIndex: i, progress };
        }
      }
      for (let i = 0; i < periodTimes.length - 1; i++) {
        const periodEnd = periodTimes[i].end;
        const nextPeriodStart = periodTimes[i + 1].start;
        if (currentTime > periodEnd && currentTime < nextPeriodStart) {
          const breakProgress = (currentTime - periodEnd) / (nextPeriodStart - periodEnd);
          return { rowIndex: i, progress: 1 + breakProgress };
        }
      }
      return null;
    };

    const timeY = getCurrentTimeY();

    const renderLesson = (lesson: any, key: string, isToday: boolean, rowIndex: number) => {
      const isCurrentTimeCell = isToday && timeY !== null && timeY.rowIndex === rowIndex;
      const timeProgress = isCurrentTimeCell && timeY ? (timeY.progress < 1 ? timeY.progress : timeY.progress - 1) : undefined;
      const subjectColor = lesson && lesson[0] ? getSubjectColor(lesson[0]) : '';
      const isDiff = lesson && lesson[2] === true;
      return (
        <div
          key={key}
          className={`timetable-cell${isToday ? ' is-today' : ''}${isCurrentTimeCell ? ' current-time-cell' : ''}`}
          style={{
            ...(timeProgress !== undefined ? { '--time-progress': timeProgress } : {}),
            ...(subjectColor ? { backgroundColor: subjectColor } : {}),
            ...(isDiff ? { border: '2px solid red', boxSizing: 'border-box' } : {}),
          } as React.CSSProperties}
        >
          {lesson ? (
            <>
              <span className="subject-name">{lesson[0]}</span>
              <span className="room-name">{lesson[1]}</span>
            </>
          ) : null}
        </div>
      );
    };

    return (
      <div className="timetable-grid">
        <div className="timetable-cell header-empty" style={{ background: 'transparent' }}></div>
        {days.map((dayLabel, index) => (
          <div key={`header-${index}`} className={`timetable-cell timetable-header${isWeekday && index === currentDay - 1 ? ' is-today' : ''}`}>
            {dayLabel}
          </div>
        ))}
        {periods.map((p, pIdx) => {
          if (pIdx === 3) {
            return (
              <React.Fragment key={`period-group-${p}`}>
                <div className="timetable-cell period">
                  <span className="period-label">4</span>
                  <span className="period-time">11:30</span>
                </div>
                {days.map((_, dIdx) => renderLesson(schedule[3]?.[dIdx], `4-${dIdx}`, isWeekday && dIdx === currentDay - 1, 3))}

                <div className="timetable-cell period lunch">
                  <span className="period-label">점심</span>
                  <span className="period-time">12:20</span>
                </div>
                {days.map((_, dIdx) => {
                  const isToday = isWeekday && dIdx === currentDay - 1;
                  const isCurrentTimeCell = isToday && timeY !== null && timeY.rowIndex === 4;
                  const timeProgress = isCurrentTimeCell && timeY ? (timeY.progress < 1 ? timeY.progress : timeY.progress - 1) : undefined;
                  return (
                    <div
                      key={`lunch-${dIdx}`}
                      className={`timetable-cell lunch-cell${isToday ? ' is-today' : ''}${isCurrentTimeCell ? ' current-time-cell' : ''}`}
                      style={timeProgress !== undefined ? { '--time-progress': timeProgress } as React.CSSProperties : undefined}
                    >
                      점심시간
                    </div>
                  );
                })}

                <div className="timetable-cell period">
                  <span className="period-label">5</span>
                  <span className="period-time">13:20</span>
                </div>
                {days.map((_, dIdx) => renderLesson(schedule[4]?.[dIdx], `5-${dIdx}`, isWeekday && dIdx === currentDay - 1, 5))}
              </React.Fragment>
            );
          }

          if (pIdx === 4) return null;

          const scheduleIdx = pIdx;
          const actualRowIndex = pIdx < 3 ? pIdx : pIdx + 1;

          return (
            <React.Fragment key={p}>
              <div className="timetable-cell period">
                <span className="period-label">{p}</span>
                <span className="period-time">{PERIOD_START_TIMES[p]}</span>
              </div>
              {days.map((_, dIdx) => renderLesson(schedule[scheduleIdx]?.[dIdx], `${p}-${dIdx}`, isWeekday && dIdx === currentDay - 1, actualRowIndex))}
            </React.Fragment>
          );
        })}
      </div>
    );
  };

  const displayTeachers = Array.from(new Set([defaultTeacher, ...favoriteTeachers].filter(Boolean)));

  return (
    <div className="timetable-section">
      {renderGrid()}

      {timetableSource === 'appin' && (
        <>
          <div className="timetable-top-hover-area"></div>
          <div className="timetable-top-hover">
            <div className="appin-week-controls" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '15px' }}>
              <button onClick={() => onAppinWeekOffsetChange(o => o - 1)} className="refresh-btn-small" style={{ borderRadius: '50%', width: '25px', height: '25px', padding: 0 }}>&lt;</button>
              <span style={{ fontWeight: 'bold', color: 'white', fontSize: '0.9rem' }}>{appinWeekRange.weekText}</span>
              <button onClick={() => onAppinWeekOffsetChange(o => o + 1)} className="refresh-btn-small" style={{ borderRadius: '50%', width: '25px', height: '25px', padding: 0 }}>&gt;</button>
            </div>
          </div>
        </>
      )}

      <div className="timetable-hover-area"></div>
      <div className="timetable-search-hover" style={{ flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: '8px' }}>
          <div className="teacher-search-container" style={{ flex: '0 0 auto', position: 'relative' }}>
            <input
              type="text"
              value={teacherSearch}
              onChange={(e) => onTeacherSearchChange(e.target.value)}
              onFocus={() => onShowTeacherDropdown(true)}
              onKeyDown={onKeyDown}
              placeholder="선생님 검색..."
              className="search-input"
              style={{ width: '140px' }}
            />
            {showTeacherDropdown && filteredTeachers.length > 0 && (
              <div className="teacher-dropdown">
                {filteredTeachers.map((teacher, index) => (
                  <div
                    key={teacher}
                    className={`teacher-dropdown-item ${index === highlightedIndex ? 'highlighted' : ''} ${teacher === selectedTeacher ? 'selected' : ''}`}
                    onClick={() => onTeacherSelect(teacher)}
                    onMouseEnter={() => onHighlightedIndexChange(index)}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  >
                    <span>{teacher}</span>
                    <button
                      onClick={(e) => onToggleFavorite(teacher, e)}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: favoriteTeachers.includes(teacher) ? '#ffd700' : 'rgba(255,255,255,0.3)',
                        fontSize: '1rem', padding: '0 4px', marginLeft: '8px',
                      }}
                      title="즐겨찾기"
                    >
                      {favoriteTeachers.includes(teacher) ? '★' : '☆'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {displayTeachers.length > 0 && (
            <div
              style={{ display: 'flex', flex: 1, overflowX: 'auto', gap: '6px', padding: '4px 0', scrollbarWidth: 'none', msOverflowStyle: 'none' }}
              onWheel={onWheelScroll}
            >
              {displayTeachers.map(t => (
                <button
                  key={t}
                  onClick={() => onTeacherSelect(t)}
                  style={{
                    padding: '4px 10px', borderRadius: '12px',
                    border: '1px solid rgba(255,255,255,0.2)',
                    background: selectedTeacher === t ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
                    color: t === defaultTeacher ? '#ffd700' : 'white',
                    whiteSpace: 'nowrap', cursor: 'pointer', fontSize: '0.9rem', flex: '0 0 auto',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

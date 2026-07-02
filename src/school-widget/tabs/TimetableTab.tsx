import React from 'react';
import { TimetableData, AppinData, PERIOD_START_TIMES, PERIOD_TIMES } from '../types';

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
  eventsByDateClass: Record<string, Record<string, string>>;
  eventsByDateGrade: Record<string, (string | null)[]>;
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
  parsedAppinTeachers, baseAppinTimetable,
  eventsByDateClass, eventsByDateGrade,
  appinWeekRange,
  onAppinWeekOffsetChange, currentNow, loading, error, onRetry,
  teacherSearch, onTeacherSearchChange, showTeacherDropdown, onShowTeacherDropdown,
  filteredTeachers, highlightedIndex, onHighlightedIndexChange, onTeacherSelect, onKeyDown,
  defaultTeacher, favoriteTeachers, onToggleFavorite, onWheelScroll,
}: Props) {

  const lookupEventLabel = (dateStr: string, className: string | null): string | null => {
    const byClass = eventsByDateClass[dateStr];
    if (className && byClass && byClass[className]) return byClass[className];
    if (className) {
      const m = /^(\d+)-/.exec(className);
      if (m) {
        const grade = parseInt(m[1], 10);
        const arr = eventsByDateGrade[dateStr];
        if (arr && arr[grade - 1]) return arr[grade - 1] as string;
      }
    }
    return null;
  };

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

          // 행사 라벨 우선 — 평소 그 시간에 수업이 있던 셀에만 표기
          const eventLabel = baseSlot ? lookupEventLabel(dateStr, baseSlot.className) : null;

          if (eventLabel) {
            schedule[pIdx][dIdx] = [eventLabel, '', true, true];
          } else if (slot) {
            const isDiff = !baseSlot || baseSlot.subject !== slot.subject || baseSlot.className !== slot.className;
            schedule[pIdx][dIdx] = [slot.subject, slot.className, isDiff, false];
          } else if (baseSlot && dateHasData) {
            schedule[pIdx][dIdx] = ['', '', true, false];
          } else if (baseSlot) {
            schedule[pIdx][dIdx] = [baseSlot.subject, baseSlot.className, false, false];
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

    // 각 행(교시·점심)은 "이 교시 시작 ~ 다음 행 시작" 구간을 나타낸다.
    // 쉬는 시간을 앞 교시 셀에 포함시켜, 시간이 흘러도 인디케이터가 뒤로 튀지 않고
    // 위→아래로 연속 이동하며 다음 교시 시작 순간 다음 셀로 넘어간다.
    // 마지막 교시는 다음 행이 없으므로 자기 종료 시각까지만 채운다.
    // 교시 시각은 types.ts 의 PERIOD_TIMES 를 공유(중복 정의 방지).
    const getCurrentTimeY = () => {
      if (currentDay < 1 || currentDay > 5) return null;
      for (let i = 0; i < PERIOD_TIMES.length; i++) {
        const spanStart = PERIOD_TIMES[i].start;
        const spanEnd =
          i + 1 < PERIOD_TIMES.length ? PERIOD_TIMES[i + 1].start : PERIOD_TIMES[i].end;
        if (currentTime >= spanStart && currentTime < spanEnd) {
          return { rowIndex: i, progress: (currentTime - spanStart) / (spanEnd - spanStart) };
        }
      }
      return null;
    };

    const timeY = getCurrentTimeY();

    const renderLesson = (lesson: any, key: string, isToday: boolean, rowIndex: number) => {
      const isCurrentTimeCell = isToday && timeY !== null && timeY.rowIndex === rowIndex;
      const timeProgress = isCurrentTimeCell && timeY ? timeY.progress : undefined;
      const isEvent = lesson && lesson[3] === true;
      const subjectColor = lesson && lesson[0] && !isEvent ? getSubjectColor(lesson[0]) : '';
      const isDiff = lesson && lesson[2] === true;
      return (
        <div
          key={key}
          className={`timetable-cell${isToday ? ' is-today' : ''}${isCurrentTimeCell ? ' current-time-cell' : ''}${isEvent ? ' event-cell' : ''}`}
          style={{
            ...(timeProgress !== undefined ? { '--time-progress': timeProgress } : {}),
            ...(subjectColor ? { backgroundColor: subjectColor } : {}),
            ...(isEvent ? { backgroundColor: 'rgba(255, 217, 102, 0.28)' } : {}),
            ...(isDiff ? { border: '2px solid red', boxSizing: 'border-box' } : {}),
          } as React.CSSProperties}
        >
          {lesson ? (
            <>
              <span className="subject-name" style={isEvent ? { fontWeight: 700 } : undefined}>{lesson[0]}</span>
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
                  const timeProgress = isCurrentTimeCell && timeY ? timeY.progress : undefined;
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

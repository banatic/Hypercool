import React, { useState, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import './SchoolWidget.css';
import { ScheduleItem } from './types/schedule';

import {
  Tab, TimetableData, MealInfo, Latecomer, PointStatus,
  AppinData, CatTypeId, CAT_TYPES,
} from './school-widget/types';
import TabBar from './school-widget/TabBar';
import TodoTab from './school-widget/tabs/TodoTab';
import MealTab from './school-widget/tabs/MealTab';
import TimetableTab from './school-widget/tabs/TimetableTab';
import AttendanceTab from './school-widget/tabs/AttendanceTab';
import PointsTab from './school-widget/tabs/PointsTab';
import SettingsTab from './school-widget/tabs/SettingsTab';
import { useCatAnimation } from './school-widget/hooks/useCatAnimation';

export default function SchoolWidget() {
  // ── Tab state ──────────────────────────────────────────────────────────────
  const [enabledTabs, setEnabledTabs] = useState<Tab[]>(() => {
    try {
      const saved = localStorage.getItem('schoolEnabledTabs');
      return saved ? JSON.parse(saved) : ['todo', 'meal', 'timetable', 'attendance', 'points'];
    } catch { return ['todo', 'meal', 'timetable', 'attendance', 'points']; }
  });
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('schoolActiveTab') as Tab | null;
    return saved ?? 'meal';
  });

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    localStorage.setItem('schoolActiveTab', tab);
  };

  // If active tab gets disabled, switch to first available enabled tab
  useEffect(() => {
    if (activeTab !== 'settings' && !enabledTabs.includes(activeTab)) {
      const first = enabledTabs[0] ?? 'settings';
      handleTabChange(first as Tab);
    }
  }, [enabledTabs]);

  // ── Timetable ──────────────────────────────────────────────────────────────
  const [timetableData, setTimetableData] = useState<TimetableData | null>(null);
  const [timetableSource, setTimetableSource] = useState<'comcigan' | 'appin'>(
    () => localStorage.getItem('schoolTimetableSource') as 'comcigan' | 'appin' || 'comcigan'
  );
  const [appinData, setAppinData] = useState<AppinData | null>(null);
  const [appinWeekOffset, setAppinWeekOffset] = useState(0);
  const [currentNow, setCurrentNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setCurrentNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (appinWeekOffset !== 0) {
      const timer = setTimeout(() => setAppinWeekOffset(0), 10 * 60 * 1000);
      return () => clearTimeout(timer);
    }
  }, [appinWeekOffset]);

  const appinWeekRange = useMemo(() => {
    const now = new Date();
    const currentDayOfWeek = now.getDay() || 7;
    const mondayDate = new Date(now);
    mondayDate.setDate(now.getDate() - currentDayOfWeek + 1 + appinWeekOffset * 7);
    const fridayDate = new Date(mondayDate);
    fridayDate.setDate(mondayDate.getDate() + 4);
    const dStr = [];
    for (let i = 0; i < 5; i++) {
      const date = new Date(mondayDate);
      date.setDate(mondayDate.getDate() + i);
      dStr.push(`${['월', '화', '수', '목', '금'][i]}(${date.getMonth() + 1}/${date.getDate()})`);
    }
    const weekText = `${mondayDate.getMonth() + 1}/${mondayDate.getDate()} ~ ${fridayDate.getMonth() + 1}/${fridayDate.getDate()}`;
    return { mondayDate, days: dStr, weekText };
  }, [appinWeekOffset]);

  const [selectedTeacher, setSelectedTeacher] = useState('');
  const [teacherSearch, setTeacherSearch] = useState('');
  const [showTeacherDropdown, setShowTeacherDropdown] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [debouncedTeacherSearch, setDebouncedTeacherSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTeacherSearch(teacherSearch), 150);
    return () => clearTimeout(timer);
  }, [teacherSearch]);

  const [favoriteTeachers, setFavoriteTeachers] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('schoolFavoriteTeachers') || '[]'); } catch { return []; }
  });

  const filteredTeachers = useMemo(() => {
    const list = timetableSource === 'appin' && appinData
      ? appinData.teachers
      : (timetableData?.teachers ?? []);
    if (!debouncedTeacherSearch) return list;
    return list.filter((t: string) => t.toLowerCase().includes(debouncedTeacherSearch.toLowerCase()));
  }, [timetableData, appinData, timetableSource, debouncedTeacherSearch]);

  const parsedAppinTeachers = useMemo(() => {
    if (!appinData) return {};
    const result: Record<string, Record<string, Record<string, { subject: string; className: string }>>> = {};
    appinData.teachers.forEach((t: string) => { result[t] = {}; });
    Object.entries(appinData.days).forEach(([dateStr, classMap]) => {
      Object.entries(classMap).forEach(([className, periodMap]) => {
        Object.entries(periodMap).forEach(([period, slot]) => {
          if (slot.teacher !== null && slot.teacher !== undefined && slot.subject !== null && slot.subject !== undefined) {
            const tName = appinData.teachers[slot.teacher!];
            if (tName) {
              if (!result[tName]) result[tName] = {};
              if (!result[tName][dateStr]) result[tName][dateStr] = {};
              result[tName][dateStr][period] = { subject: appinData.subjects[slot.subject!], className };
            }
          }
        });
      });
    });
    return result;
  }, [appinData]);

  const baseAppinTimetable = useMemo(() => {
    if (!selectedTeacher || !appinData || !parsedAppinTeachers[selectedTeacher]) return null;
    const dailyData = parsedAppinTeachers[selectedTeacher];
    const base: Record<number, Record<number, { subject: string; className: string } | null>> = {};
    for (let d = 1; d <= 5; d++) {
      base[d] = {};
      for (let p = 1; p <= 7; p++) {
        const counts: Record<string, { count: number; data: { subject: string; className: string } }> = {};
        Object.entries(dailyData).forEach(([dateStr, periodMap]) => {
          const dateObj = new Date(dateStr);
          if (dateObj.getDay() === d) {
            const slot = periodMap[p.toString()];
            if (slot) {
              const key = `${slot.subject}|${slot.className}`;
              if (!counts[key]) counts[key] = { count: 0, data: slot };
              counts[key].count++;
            }
          }
        });
        let best: { count: number; data: { subject: string; className: string } } | null = null;
        Object.values(counts).forEach(c => { if (!best || c.count > best.count) best = c as any; });
        base[d][p] = best ? (best as any).data : null;
      }
    }
    return base;
  }, [selectedTeacher, appinData, parsedAppinTeachers]);

  // ── Data ───────────────────────────────────────────────────────────────────
  const [mealInfo, setMealInfo] = useState<MealInfo>({ lunch: 'Loading...', dinner: 'Loading...' });
  const [latecomers, setLatecomers] = useState<Latecomer[]>([]);
  const [points, setPoints] = useState<PointStatus[]>([]);
  const [todos, setTodos] = useState<ScheduleItem[]>([]);
  const [newTodoText, setNewTodoText] = useState('');

  const [loadingStates, setLoadingStates] = useState({ todo: false, timetable: false, meal: false, attendance: false, points: false });
  const [errorStates, setErrorStates] = useState({ timetable: false, meal: false, attendance: false, points: false });
  const [dataLoaded, setDataLoaded] = useState({ todo: false, timetable: false, appin: false, meal: false, attendance: false, points: false });

  // ── Settings ───────────────────────────────────────────────────────────────
  const [grade, setGrade] = useState(() => localStorage.getItem('schoolGrade') || '1');
  const [classNum, setClassNum] = useState(() => localStorage.getItem('schoolClass') || '8');
  const [schoolWidgetPinned, setSchoolWidgetPinned] = useState(false);
  const [defaultTeacher, setDefaultTeacher] = useState('');
  const [regionCode, setRegionCode] = useState(() => localStorage.getItem('schoolRegionCode') || 'C10');
  const [schoolCode, setSchoolCode] = useState(() => localStorage.getItem('schoolCode') || '7150451');

  // ── Cat ────────────────────────────────────────────────────────────────────
  const [enabledCats, setEnabledCats] = useState<CatTypeId[]>(() => {
    const saved = localStorage.getItem('schoolEnabledCats');
    if (saved) { try { return JSON.parse(saved); } catch { return ['default']; } }
    return localStorage.getItem('schoolCatEnabled') === 'false' ? [] : ['default'];
  });
  const [catSize, setCatSize] = useState(() => parseInt(localStorage.getItem('schoolCatSize') || '32', 10));

  const { catStatesRef, catElementsRef, visibleCats, setVisibleCats, isPixelHit } = useCatAnimation(enabledCats, catSize);

  // ── Effects ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let lastCall = 0;
    const sendToBottom = () => {
      const now = Date.now();
      if (now - lastCall < 500) return;
      lastCall = now;
      invoke('send_window_to_bottom').catch(console.error);
    };
    window.addEventListener('mousedown', sendToBottom);
    window.addEventListener('focus', sendToBottom);
    return () => { window.removeEventListener('mousedown', sendToBottom); window.removeEventListener('focus', sendToBottom); };
  }, []);

  useEffect(() => {
    localStorage.setItem('schoolGrade', grade);
    localStorage.setItem('schoolClass', classNum);
    setDataLoaded(prev => ({ ...prev, attendance: false, points: false }));
    setLatecomers([]);
    setPoints([]);
  }, [grade, classNum]);

  useEffect(() => {
    setDataLoaded(prev => ({ ...prev, meal: false }));
  }, [regionCode, schoolCode]);

  useEffect(() => {
    if (selectedTeacher) localStorage.setItem('lastSelectedTeacher', selectedTeacher);
  }, [selectedTeacher]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        setSchoolWidgetPinned(await invoke<boolean>('get_school_widget_pinned'));
        const savedTeacher = await invoke<string | null>('get_registry_value', { key: 'SchoolDefaultTeacher' });
        if (savedTeacher) setDefaultTeacher(savedTeacher);
        const savedRegion = await invoke<string | null>('get_registry_value', { key: 'SchoolRegionCode' });
        if (savedRegion) { setRegionCode(savedRegion); localStorage.setItem('schoolRegionCode', savedRegion); }
        const savedSchool = await invoke<string | null>('get_registry_value', { key: 'SchoolCode' });
        if (savedSchool) { setSchoolCode(savedSchool); localStorage.setItem('schoolCode', savedSchool); }
      } catch { /* ignore */ }
    };
    loadSettings();
  }, []);

  useEffect(() => {
    if (timetableData?.teachers.length && timetableSource === 'comcigan') {
      if (defaultTeacher && timetableData.teachers.includes(defaultTeacher)) {
        setSelectedTeacher(defaultTeacher);
      } else {
        const saved = localStorage.getItem('lastSelectedTeacher');
        setSelectedTeacher(saved && timetableData.teachers.includes(saved) ? saved : timetableData.teachers[0]);
      }
    } else if (appinData?.teachers.length && timetableSource === 'appin') {
      if (defaultTeacher && appinData.teachers.includes(defaultTeacher)) {
        setSelectedTeacher(defaultTeacher);
      } else {
        const saved = localStorage.getItem('lastSelectedTeacher');
        setSelectedTeacher(saved && appinData.teachers.includes(saved) ? saved : appinData.teachers[0]);
      }
    }
  }, [timetableData, appinData, defaultTeacher, timetableSource]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.teacher-search-container')) setShowTeacherDropdown(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ── Fetch functions ────────────────────────────────────────────────────────
  const fetchTimetable = async () => {
    if (timetableSource === 'appin') {
      if (dataLoaded.appin && appinData) return;
      setLoadingStates(prev => ({ ...prev, timetable: true }));
      setErrorStates(prev => ({ ...prev, timetable: false }));
      try {
        const data = await invoke<AppinData>('get_appin_timetable_data');
        setAppinData(data);
        setDataLoaded(prev => ({ ...prev, appin: true }));
        if (data.teachers?.length) {
          const saved = localStorage.getItem('lastSelectedTeacher');
          setSelectedTeacher(saved && data.teachers.includes(saved) ? saved : data.teachers[0]);
        }
      } catch { setErrorStates(prev => ({ ...prev, timetable: true })); }
      finally { setLoadingStates(prev => ({ ...prev, timetable: false })); }
    } else {
      if (dataLoaded.timetable && timetableData) return;
      setLoadingStates(prev => ({ ...prev, timetable: true }));
      setErrorStates(prev => ({ ...prev, timetable: false }));
      try {
        const data = await invoke<TimetableData>('get_timetable_data');
        setTimetableData(data);
        setDataLoaded(prev => ({ ...prev, timetable: true }));
        if (data.teachers.length) {
          const saved = localStorage.getItem('lastSelectedTeacher');
          setSelectedTeacher(saved && data.teachers.includes(saved) ? saved : data.teachers[0]);
        }
      } catch { setErrorStates(prev => ({ ...prev, timetable: true })); }
      finally { setLoadingStates(prev => ({ ...prev, timetable: false })); }
    }
  };

  const fetchMeal = async () => {
    if (dataLoaded.meal) return;
    setLoadingStates(prev => ({ ...prev, meal: true }));
    try {
      const now = new Date();
      const kstDate = new Date(now.getTime() + (now.getTimezoneOffset() + 9 * 60) * 60000);
      const date = `${kstDate.getFullYear()}${String(kstDate.getMonth() + 1).padStart(2, '0')}${String(kstDate.getDate()).padStart(2, '0')}`;
      const data = await invoke<MealInfo>('get_meal_data', { date, atptCode: regionCode, schoolCode });
      setMealInfo(data);
      setDataLoaded(prev => ({ ...prev, meal: true }));
    } catch {
      setMealInfo({ lunch: '급식 정보를 불러올 수 없습니다', dinner: '석식 정보를 불러올 수 없습니다' });
      setErrorStates(prev => ({ ...prev, meal: true }));
    } finally { setLoadingStates(prev => ({ ...prev, meal: false })); }
  };

  const fetchAttendance = async (forceRefresh = false) => {
    if (!forceRefresh && dataLoaded.attendance && latecomers.length > 0) return;
    setLoadingStates(prev => ({ ...prev, attendance: true }));
    try {
      const response = await invoke<[Latecomer[], string]>('get_attendance_data', { grade, class: classNum });
      if (response?.[0] && Array.isArray(response[0])) {
        setLatecomers(response[0]);
        setDataLoaded(prev => ({ ...prev, attendance: true }));
      } else setLatecomers([]);
    } catch { setLatecomers([]); }
    finally { setLoadingStates(prev => ({ ...prev, attendance: false })); }
  };

  const fetchPoints = async (forceRefresh = false) => {
    if (!forceRefresh && dataLoaded.points && points.length > 0) return;
    setLoadingStates(prev => ({ ...prev, points: true }));
    try {
      const response = await invoke<[PointStatus[], string]>('get_points_data', { grade, class: classNum });
      if (response?.[0] && Array.isArray(response[0])) {
        setPoints(response[0]);
        setDataLoaded(prev => ({ ...prev, points: true }));
      } else setPoints([]);
    } catch { setPoints([]); }
    finally { setLoadingStates(prev => ({ ...prev, points: false })); }
  };

  const fetchTodos = () => {
    if (dataLoaded.todo && todos.length > 0) return;
    setLoadingStates(prev => ({ ...prev, todo: true }));
    try {
      const saved = localStorage.getItem('schoolWidgetTodos');
      const parsed: ScheduleItem[] = saved ? JSON.parse(saved) : [];
      parsed.sort((a, b) => {
        if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      setTodos(parsed);
      setDataLoaded(prev => ({ ...prev, todo: true }));
    } catch { setTodos([]); }
    finally { setLoadingStates(prev => ({ ...prev, todo: false })); }
  };

  useEffect(() => {
    switch (activeTab) {
      case 'todo': if (!dataLoaded.todo) fetchTodos(); break;
      case 'meal': if (!dataLoaded.meal) fetchMeal(); break;
      case 'timetable':
        if (timetableSource === 'appin') { if (!dataLoaded.appin) fetchTimetable(); }
        else { if (!dataLoaded.timetable) fetchTimetable(); }
        break;
      case 'attendance': if (!dataLoaded.attendance) fetchAttendance(); break;
      case 'points': if (!dataLoaded.points) fetchPoints(); break;
    }
  }, [activeTab]);

  // ── Todo handlers ──────────────────────────────────────────────────────────
  const handleAddTodo = () => {
    if (!newTodoText.trim()) return;
    const now = new Date().toISOString();
    const newTodo: ScheduleItem = {
      id: 'todo-' + Date.now().toString(36) + Math.random().toString(36).substr(2),
      type: 'manual_todo', title: newTodoText.trim(), content: '',
      startDate: now, endDate: now, isAllDay: true,
      isCompleted: false, createdAt: now, updatedAt: now, isDeleted: false,
    };
    const updated = [newTodo, ...todos].sort((a, b) => {
      if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    setTodos(updated);
    localStorage.setItem('schoolWidgetTodos', JSON.stringify(updated));
    setNewTodoText('');
  };

  const handleToggleTodo = (todo: ScheduleItem) => {
    const updated = todos
      .map(t => t.id === todo.id ? { ...t, isCompleted: !t.isCompleted, updatedAt: new Date().toISOString() } : t)
      .sort((a, b) => {
        if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    setTodos(updated);
    localStorage.setItem('schoolWidgetTodos', JSON.stringify(updated));
  };

  const handleDeleteTodo = (id: string) => {
    const updated = todos.filter(t => t.id !== id);
    setTodos(updated);
    localStorage.setItem('schoolWidgetTodos', JSON.stringify(updated));
  };

  // ── Teacher handlers ───────────────────────────────────────────────────────
  const handleTeacherSearchChange = (value: string) => {
    setTeacherSearch(value);
    setShowTeacherDropdown(true);
    setHighlightedIndex(-1);
  };

  const handleTeacherSelect = (teacher: string) => {
    setSelectedTeacher(teacher);
    setTeacherSearch('');
    setShowTeacherDropdown(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showTeacherDropdown || filteredTeachers.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightedIndex(prev => Math.min(prev + 1, filteredTeachers.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightedIndex(prev => prev > 0 ? prev - 1 : -1); }
    else if (e.key === 'Enter' && highlightedIndex >= 0) { e.preventDefault(); handleTeacherSelect(filteredTeachers[highlightedIndex]); }
    else if (e.key === 'Escape') { setShowTeacherDropdown(false); setHighlightedIndex(-1); }
  };

  const toggleFavoriteTeacher = (teacher: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setFavoriteTeachers(prev => {
      const next = prev.includes(teacher) ? prev.filter(t => t !== teacher) : [...prev, teacher];
      localStorage.setItem('schoolFavoriteTeachers', JSON.stringify(next));
      return next;
    });
  };

  const handleWheelScroll = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY;
  };

  // ── Settings save ──────────────────────────────────────────────────────────
  const saveSettings = async () => {
    try {
      await invoke('set_school_widget_pinned', { pinned: schoolWidgetPinned });
      if (defaultTeacher) await invoke('set_registry_value', { key: 'SchoolDefaultTeacher', value: defaultTeacher });
      await invoke('set_registry_value', { key: 'SchoolGrade', value: grade });
      await invoke('set_registry_value', { key: 'SchoolClass', value: classNum });
      await invoke('set_registry_value', { key: 'SchoolRegionCode', value: regionCode });
      await invoke('set_registry_value', { key: 'SchoolCode', value: schoolCode });
      localStorage.setItem('schoolRegionCode', regionCode);
      localStorage.setItem('schoolCode', schoolCode);
      setDataLoaded(prev => ({ ...prev, meal: false }));
      alert('설정이 저장되었습니다.');
    } catch { alert('설정 저장에 실패했습니다.'); }
  };

  // ── Timetable source switch ────────────────────────────────────────────────
  const handleTimetableSourceChange = (src: 'comcigan' | 'appin') => {
    setTimetableSource(src);
    if (src === 'comcigan' && timetableData?.teachers.length) {
      const saved = localStorage.getItem('lastSelectedTeacher');
      setSelectedTeacher(saved && timetableData.teachers.includes(saved) ? saved : timetableData.teachers[0]);
    } else if (src === 'appin' && appinData?.teachers.length) {
      const saved = localStorage.getItem('lastSelectedTeacher');
      setSelectedTeacher(saved && appinData.teachers.includes(saved) ? saved : appinData.teachers[0]);
    } else {
      setSelectedTeacher('');
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="school-widget-container">
      <TabBar activeTab={activeTab} enabledTabs={enabledTabs} onTabChange={handleTabChange} />

      <div className="tab-content">
        {activeTab === 'todo' && (
          <TodoTab
            todos={todos} loading={loadingStates.todo}
            newTodoText={newTodoText} onNewTodoTextChange={setNewTodoText}
            onAdd={handleAddTodo} onToggle={handleToggleTodo} onDelete={handleDeleteTodo}
          />
        )}
        {activeTab === 'meal' && (
          <MealTab mealInfo={mealInfo} loading={loadingStates.meal} />
        )}
        {activeTab === 'timetable' && (
          <TimetableTab
            timetableSource={timetableSource}
            timetableData={timetableData}
            appinData={appinData}
            selectedTeacher={selectedTeacher}
            parsedAppinTeachers={parsedAppinTeachers}
            baseAppinTimetable={baseAppinTimetable}
            appinWeekRange={appinWeekRange}
            onAppinWeekOffsetChange={setAppinWeekOffset}
            currentNow={currentNow}
            loading={loadingStates.timetable}
            error={errorStates.timetable}
            onRetry={() => { setDataLoaded(prev => ({ ...prev, timetable: false, appin: false })); fetchTimetable(); }}
            teacherSearch={teacherSearch}
            onTeacherSearchChange={handleTeacherSearchChange}
            showTeacherDropdown={showTeacherDropdown}
            onShowTeacherDropdown={setShowTeacherDropdown}
            filteredTeachers={filteredTeachers}
            highlightedIndex={highlightedIndex}
            onHighlightedIndexChange={setHighlightedIndex}
            onTeacherSelect={handleTeacherSelect}
            onKeyDown={handleKeyDown}
            defaultTeacher={defaultTeacher}
            favoriteTeachers={favoriteTeachers}
            onToggleFavorite={toggleFavoriteTeacher}
            onWheelScroll={handleWheelScroll}
          />
        )}
        {activeTab === 'attendance' && (
          <AttendanceTab
            latecomers={latecomers} loading={loadingStates.attendance}
            onRefresh={() => fetchAttendance(true)}
          />
        )}
        {activeTab === 'points' && (
          <PointsTab
            points={points} loading={loadingStates.points}
            onRefresh={() => fetchPoints(true)}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsTab
            timetableSource={timetableSource}
            onTimetableSourceChange={handleTimetableSourceChange}
            schoolWidgetPinned={schoolWidgetPinned}
            onSchoolWidgetPinnedChange={setSchoolWidgetPinned}
            enabledTabs={enabledTabs}
            onEnabledTabsChange={setEnabledTabs}
            enabledCats={enabledCats}
            onEnabledCatsChange={(cats) => {
              const removed = enabledCats.filter(id => !cats.includes(id));
              removed.forEach(id => {
                catStatesRef.current.delete(id);
                setVisibleCats(prev => { const next = new Set(prev); next.delete(id); return next; });
              });
              setEnabledCats(cats);
            }}
            catSize={catSize}
            onCatSizeReset={() => { setCatSize(32); localStorage.setItem('schoolCatSize', '32'); }}
            timetableData={timetableData}
            appinData={appinData}
            defaultTeacher={defaultTeacher}
            onDefaultTeacherChange={setDefaultTeacher}
            grade={grade}
            onGradeChange={setGrade}
            classNum={classNum}
            onClassNumChange={setClassNum}
            regionCode={regionCode}
            onRegionCodeChange={setRegionCode}
            schoolCode={schoolCode}
            onSchoolCodeChange={setSchoolCode}
            onSave={saveSettings}
          />
        )}
      </div>

      {/* Cat sprites - rendered outside tab-content so visible on all tabs */}
      {Array.from(visibleCats).map(catId => {
        const catType = CAT_TYPES.find(t => t.id === catId);
        if (!catType) return null;
        return (
          <div
            key={catId}
            ref={(el) => catElementsRef.current.set(catId, el)}
            className="cat-sprite"
            onClick={(e) => {
              const cat = catStatesRef.current.get(catId);
              if (!cat) return;
              const container = document.querySelector('.school-widget-container');
              if (!container) return;
              const rect = container.getBoundingClientRect();
              const clickX = e.clientX - rect.left;
              const clickY = e.clientY - rect.top;
              if (!isPixelHit(catId, clickX, clickY, cat.x, cat.y, catSize, cat.direction, cat.behavior.type, cat.frame)) return;
              const newSize = catSize + 1;
              setCatSize(newSize);
              localStorage.setItem('schoolCatSize', newSize.toString());
              const currentTime = performance.now();
              cat.behavior = Math.random() < 0.5
                ? { type: 'sitting', phase: 'enter', phaseStartTime: currentTime, actionStartTime: currentTime }
                : { type: 'lying', phase: 'enter', phaseStartTime: currentTime, actionStartTime: currentTime };
              cat.frame = 0;
            }}
            style={{
              position: 'absolute', left: '0px', top: '0px',
              width: `${catSize}px`, height: `${catSize}px`,
              backgroundImage: `url(${new URL(`./asset/${catType.sprite}`, import.meta.url).href})`,
              backgroundSize: `${catSize * 4}px ${catSize * catType.rows}px`,
              backgroundPosition: '0px 0px',
              imageRendering: 'pixelated',
              cursor: 'pointer', zIndex: 10, pointerEvents: 'none',
            }}
          />
        );
      })}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SchoolWidget />
  </React.StrictMode>
);

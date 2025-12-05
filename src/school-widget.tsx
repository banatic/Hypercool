import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import './SchoolWidget.css';

// Types
interface TimetableData {
  teachers: string[];
  subjects: string[];
  timetables: Record<string, string[][][]>;
}

interface MealInfo {
  lunch: string;
  dinner: string;
}

interface Latecomer {
  student_info: string;
  arrival_time: string;
  attendance_status: string;
}

interface PointStatus {
  student_info: string;
  reward: number;
  penalty: number;
  offset: number;
  total: number;
}

type Tab = 'meal' | 'timetable' | 'attendance' | 'points' | 'settings';

export default function SchoolWidget() {
  const [activeTab, setActiveTab] = useState<Tab>('meal');
  const [timetableData, setTimetableData] = useState<TimetableData | null>(null);
  const [selectedTeacher, setSelectedTeacher] = useState<string>('');
  const [teacherSearch, setTeacherSearch] = useState('');
  const [mealInfo, setMealInfo] = useState<MealInfo>({ lunch: 'Loading...', dinner: 'Loading...' });
  const [latecomers, setLatecomers] = useState<Latecomer[]>([]);
  const [points, setPoints] = useState<PointStatus[]>([]);
  const [catState, setCatState] = useState<{
    x: number;
    y: number;
    direction: 'down' | 'right' | 'up' | 'left';
    action: 'walking' | 'sitting' | 'licking' | 'lying';
    frame: number;
    actionPhase?: 'forward' | 'hold' | 'reverse' | 'loop'; // 액션 진행 단계
    holdStartTime?: number; // 유지 시작 시간
  } | null>(null);
  const targetPosRef = useRef<{ x: number; y: number } | null>(null); // 목표 위치 (마우스 위치)
  
  const [loadingStates, setLoadingStates] = useState({
    timetable: false,
    meal: false,
    attendance: false,
    points: false
  });

  const [grade, setGrade] = useState(() => localStorage.getItem('schoolGrade') || '1');
  const [classNum, setClassNum] = useState(() => localStorage.getItem('schoolClass') || '8');
  
  // 설정 상태
  const [schoolWidgetPinned, setSchoolWidgetPinned] = useState(false);
  const [defaultTeacher, setDefaultTeacher] = useState('');
  const [regionCode, setRegionCode] = useState(() => localStorage.getItem('schoolRegionCode') || 'C10');
  const [schoolCode, setSchoolCode] = useState(() => localStorage.getItem('schoolCode') || '7150451');
  const [catEnabled, setCatEnabled] = useState(() => localStorage.getItem('schoolCatEnabled') !== 'false'); // 기본값 true
  const [catSize, setCatSize] = useState(() => parseInt(localStorage.getItem('schoolCatSize') || '32', 10)); // 기본값 32px
  
  // 픽셀 데이터 캐싱을 위한 ref
  const spritePixelDataRef = useRef<Map<string, ImageData>>(new Map());
  const spriteImageRef = useRef<HTMLImageElement | null>(null);

  // 캐싱 상태 관리
  const [dataLoaded, setDataLoaded] = useState({
    timetable: false,
    meal: false,
    attendance: false,
    points: false
  });

  const [showTeacherDropdown, setShowTeacherDropdown] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const filteredTeachers = useMemo(() => {
    if (!timetableData) return [];
    if (!teacherSearch) return timetableData.teachers;
    return timetableData.teachers.filter(t => 
      t.toLowerCase().includes(teacherSearch.toLowerCase())
    );
  }, [timetableData, teacherSearch]);

  // 고양이 스프라이트 행 번호 계산
  const getCatSpriteRow = (direction: 'down' | 'right' | 'up' | 'left', action: 'walking' | 'sitting' | 'licking' | 'lying'): number => {
    if (action === 'walking') {
      switch (direction) {
        case 'down': return 0;  // 1행: 아래로 걷기
        case 'right': return 1; // 2행: 오른쪽 걷기
        case 'up': return 2;    // 3행: 위로 걷기
        case 'left': return 3;  // 4행: 왼쪽 걷기
      }
    } else {
      switch (action) {
        case 'sitting': return 4;   // 5행: 앉기
        case 'licking': return 5;   // 6행: 손핥기
        case 'lying': return 6;     // 7행: 오른쪽 보다가 바닥에 눕기
        default: return 1;
      }
    }
  };

  // 스프라이트 이미지 로드 및 픽셀 데이터 캐싱
  useEffect(() => {
    const loadSpriteImage = () => {
      const img = new Image();
      img.src = new URL('./asset/stardew-cat.png', import.meta.url).href;
      img.onload = () => {
        spriteImageRef.current = img;
        
        // 캔버스 생성 및 픽셀 데이터 추출
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        // 스프라이트 시트 크기: 8행 4열, 각 프레임 32x32
        const frameWidth = 32;
        const frameHeight = 32;
        const cols = 4;
        const rows = 8;
        
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        
        // 각 프레임의 픽셀 데이터 캐싱
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            // 해당 프레임 영역만 그리기
            ctx.clearRect(0, 0, frameWidth, frameHeight);
            ctx.drawImage(
              img,
              col * frameWidth, row * frameHeight, frameWidth, frameHeight,
              0, 0, frameWidth, frameHeight
            );
            
            // 픽셀 데이터 추출
            const imageData = ctx.getImageData(0, 0, frameWidth, frameHeight);
            const key = `${row}-${col}`;
            spritePixelDataRef.current.set(key, imageData);
          }
        }
      };
      img.onerror = () => {
        console.error('Failed to load cat sprite image');
      };
    };
    
    loadSpriteImage();
  }, []);

  // 픽셀 퍼펙트 히트 테스트 함수
  const isPixelHit = (
    clickX: number,
    clickY: number,
    catX: number,
    catY: number,
    catSize: number,
    direction: 'down' | 'right' | 'up' | 'left',
    action: 'walking' | 'sitting' | 'licking' | 'lying',
    frame: number
  ): boolean => {
    // 클릭 위치가 고양이 영역 밖이면 false
    if (
      clickX < catX ||
      clickX > catX + catSize ||
      clickY < catY ||
      clickY > catY + catSize
    ) {
      return false;
    }
    
    // 스프라이트 이미지가 아직 로드되지 않았으면 기본 히트 테스트 (사각형)
    if (!spriteImageRef.current || spritePixelDataRef.current.size === 0) {
      return true;
    }
    
    // 클릭 위치를 고양이 로컬 좌표로 변환
    const localX = clickX - catX;
    const localY = clickY - catY;
    
    // 원본 프레임 크기(32x32)로 스케일링
    const originalFrameSize = 32;
    const scale = catSize / originalFrameSize;
    const originalX = Math.floor(localX / scale);
    const originalY = Math.floor(localY / scale);
    
    // 범위 체크
    if (
      originalX < 0 ||
      originalX >= originalFrameSize ||
      originalY < 0 ||
      originalY >= originalFrameSize
    ) {
      return false;
    }
    
    // 해당 프레임의 픽셀 데이터 가져오기
    const row = getCatSpriteRow(direction, action);
    const col = frame;
    const key = `${row}-${col}`;
    const pixelData = spritePixelDataRef.current.get(key);
    
    if (!pixelData) {
      return true; // 픽셀 데이터가 없으면 기본 히트 테스트
    }
    
    // 해당 위치의 픽셀 알파값 확인
    const pixelIndex = (originalY * originalFrameSize + originalX) * 4;
    const alpha = pixelData.data[pixelIndex + 3];
    
    // 알파값이 0보다 크면 실제 고양이 영역
    return alpha > 0;
  };

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
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev => 
        prev < filteredTeachers.length - 1 ? prev + 1 : prev
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => prev > 0 ? prev - 1 : -1);
    } else if (e.key === 'Enter' && highlightedIndex >= 0) {
      e.preventDefault();
      handleTeacherSelect(filteredTeachers[highlightedIndex]);
    } else if (e.key === 'Escape') {
      setShowTeacherDropdown(false);
      setHighlightedIndex(-1);
    }
  };

  // Save grade and class
  useEffect(() => {
    localStorage.setItem('schoolGrade', grade);
    localStorage.setItem('schoolClass', classNum);
    // 학년/반이 변경되면 출결/상벌점 캐시 초기화
    setDataLoaded(prev => ({ ...prev, attendance: false, points: false }));
    setLatecomers([]);
    setPoints([]);
  }, [grade, classNum]);

  // 지역 코드나 학교 코드가 변경되면 급식 데이터 캐시 초기화
  useEffect(() => {
    setDataLoaded(prev => ({ ...prev, meal: false }));
  }, [regionCode, schoolCode]);

  // Fetch functions
  const fetchTimetable = async () => {
    if (dataLoaded.timetable && timetableData) return; // Already loaded
    setLoadingStates(prev => ({ ...prev, timetable: true }));
    try {
      const data = await invoke<TimetableData>('get_timetable_data');
      setTimetableData(data);
      setDataLoaded(prev => ({ ...prev, timetable: true }));
      if (data.teachers.length > 0) {
        const savedTeacher = localStorage.getItem('lastSelectedTeacher');
        setSelectedTeacher(
          (savedTeacher && data.teachers.includes(savedTeacher)) ? savedTeacher : data.teachers[0]
        );
      }
    } catch (error) {
      // Failed to fetch timetable
    } finally {
      setLoadingStates(prev => ({ ...prev, timetable: false }));
    }
  };

  const fetchMeal = async () => {
    if (dataLoaded.meal) return; // Already loaded
    setLoadingStates(prev => ({ ...prev, meal: true }));
    try {
      // 한국 시간대(KST, UTC+9) 기준으로 오늘 날짜 가져오기
      const now = new Date();
      const kstOffset = 9 * 60; // KST는 UTC+9시간
      const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
      const kstDate = new Date(utc + (kstOffset * 60000));
      const year = kstDate.getFullYear();
      const month = String(kstDate.getMonth() + 1).padStart(2, '0');
      const day = String(kstDate.getDate()).padStart(2, '0');
      const date = `${year}${month}${day}`;
      const data = await invoke<MealInfo>('get_meal_data', { 
        date,
        atptCode: regionCode,
        schoolCode: schoolCode
      });
      setMealInfo(data);
      setDataLoaded(prev => ({ ...prev, meal: true }));
    } catch (error) {
      setMealInfo({ lunch: '급식 정보를 불러올 수 없습니다', dinner: '석식 정보를 불러올 수 없습니다' });
    } finally {
      setLoadingStates(prev => ({ ...prev, meal: false }));
    }
  };

  const fetchAttendance = async (forceRefresh = false) => {
    if (!forceRefresh && dataLoaded.attendance && latecomers.length > 0) return; // Already loaded
    setLoadingStates(prev => ({ ...prev, attendance: true }));
    try {
      const response = await invoke<{ data: Latecomer[], debug_html: string }>('get_attendance_data', { grade, class: classNum });
      if (response.data && Array.isArray(response.data)) {
        setLatecomers(response.data);
        setDataLoaded(prev => ({ ...prev, attendance: true }));
      } else {
        setLatecomers([]);
      }
    } catch (error) {
      setLatecomers([]);
    } finally {
      setLoadingStates(prev => ({ ...prev, attendance: false }));
    }
  };

  const fetchPoints = async (forceRefresh = false) => {
    if (!forceRefresh && dataLoaded.points && points.length > 0) return; // Already loaded
    setLoadingStates(prev => ({ ...prev, points: true }));
    try {
      const response = await invoke<{ data: PointStatus[], debug_html: string }>('get_points_data', { grade, class: classNum });
      if (response.data && Array.isArray(response.data)) {
        setPoints(response.data);
        setDataLoaded(prev => ({ ...prev, points: true }));
      } else {
        setPoints([]);
      }
    } catch (error) {
      setPoints([]);
    } finally {
      setLoadingStates(prev => ({ ...prev, points: false }));
    }
  };

  // Load data based on active tab (only on initial load)
  useEffect(() => {
    switch (activeTab) {
      case 'meal':
        if (!dataLoaded.meal) {
          fetchMeal();
        }
        break;
      case 'timetable':
        if (!dataLoaded.timetable) {
          fetchTimetable();
        }
        break;
      case 'attendance':
        if (!dataLoaded.attendance) {
          fetchAttendance();
        }
        break;
      case 'points':
        if (!dataLoaded.points) {
          fetchPoints();
        }
        break;
    }
  }, [activeTab]);

  // Save selected teacher
  useEffect(() => {
    if (selectedTeacher) {
      localStorage.setItem('lastSelectedTeacher', selectedTeacher);
    }
  }, [selectedTeacher]);

  // 설정 불러오기
  useEffect(() => {
    const loadSettings = async () => {
      try {
        // 학교 위젯 핀 상태
        const pinned = await invoke<boolean>('get_school_widget_pinned');
        setSchoolWidgetPinned(pinned);
        
        // 기본 선생님
        const savedDefaultTeacher = await invoke<string | null>('get_registry_value', { key: 'SchoolDefaultTeacher' });
        if (savedDefaultTeacher) {
          setDefaultTeacher(savedDefaultTeacher);
        }
        
        // 지역 코드와 학교 코드
        const savedRegionCode = await invoke<string | null>('get_registry_value', { key: 'SchoolRegionCode' });
        if (savedRegionCode) {
          setRegionCode(savedRegionCode);
          localStorage.setItem('schoolRegionCode', savedRegionCode);
        }
        
        const savedSchoolCode = await invoke<string | null>('get_registry_value', { key: 'SchoolCode' });
        if (savedSchoolCode) {
          setSchoolCode(savedSchoolCode);
          localStorage.setItem('schoolCode', savedSchoolCode);
        }
        
      } catch (error) {
        // Failed to load settings
      }
    };
    loadSettings();
  }, []);

  // 시간표 데이터 로드 시 기본 선생님 설정
  useEffect(() => {
    if (timetableData && timetableData.teachers.length > 0) {
      if (defaultTeacher && timetableData.teachers.includes(defaultTeacher)) {
        setSelectedTeacher(defaultTeacher);
      } else {
        const savedTeacher = localStorage.getItem('lastSelectedTeacher');
        setSelectedTeacher(
          (savedTeacher && timetableData.teachers.includes(savedTeacher)) ? savedTeacher : timetableData.teachers[0]
        );
      }
    }
  }, [timetableData, defaultTeacher]);

  // 설정 저장 함수
  const saveSettings = async () => {
    try {
      // 학교 위젯 핀 상태
      await invoke('set_school_widget_pinned', { pinned: schoolWidgetPinned });
      
      // 기본 선생님
      if (defaultTeacher) {
        await invoke('set_registry_value', { key: 'SchoolDefaultTeacher', value: defaultTeacher });
      }
      
      // 학년/반
      await invoke('set_registry_value', { key: 'SchoolGrade', value: grade });
      await invoke('set_registry_value', { key: 'SchoolClass', value: classNum });
      
      // 지역 코드와 학교 코드
      await invoke('set_registry_value', { key: 'SchoolRegionCode', value: regionCode });
      await invoke('set_registry_value', { key: 'SchoolCode', value: schoolCode });
      localStorage.setItem('schoolRegionCode', regionCode);
      localStorage.setItem('schoolCode', schoolCode);
      
      // 급식 데이터 캐시 초기화 (코드가 변경되었으므로)
      setDataLoaded(prev => ({ ...prev, meal: false }));
      
      
      alert('설정이 저장되었습니다.');
    } catch (error) {
      alert('설정 저장에 실패했습니다.');
    }
  };

  // 교과목 이름을 기반으로 색상 생성
  const getSubjectColor = (subjectName: string): string => {
    if (!subjectName) return '';
  
    // 간단한 해시 생성
    let hash = 0;
    for (let i = 0; i < subjectName.length; i++) {
      hash = subjectName.charCodeAt(i) + ((hash << 5) - hash);
    }
  
    // 기본 RGB 추출 (0~255)
    let r = (hash & 0xFF0000) >> 16;
    let g = (hash & 0x00FF00) >> 8;
    let b = (hash & 0x0000FF);
  
    // 파스텔톤: 흰색(255)을 일정 비율로 섞어 밝게 만들기
    const mix = 0.3; // 0~1. 값이 클수록 더 파스텔톤
    r = Math.round(r * (1 - mix) + 255 * mix);
    g = Math.round(g * (1 - mix) + 255 * mix);
    b = Math.round(b * (1 - mix) + 255 * mix);
  
    const transparent = 0.15;
  
    return `rgba(${r}, ${g}, ${b}, ${transparent})`;
  };
  

  const renderTimetable = () => {
    if (loadingStates.timetable) return <div className="loading">Loading...</div>;
    if (!timetableData || !selectedTeacher) return <div className="error-message">No Data</div>;

    const schedule = timetableData.timetables[selectedTeacher];
    if (!schedule) return <div className="error-message">No Schedule for {selectedTeacher}</div>;


    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const periods = [1, 2, 3, 4, 5, 6, 7]; // 8교시 제거

    // 현재 시간 계산
    const now = new Date();
    const currentDay = now.getDay(); // 0=일요일, 1=월요일, ..., 5=금요일
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTime = currentHour * 60 + currentMinute; // 분 단위로 변환

    // 교시별 시간 (시작 시간, 분 단위) - 점심시간 포함
    // 실제 렌더링 순서: 1, 2, 3, 4, 점심, 5, 6, 7
    const periodTimes = [
      { start: 8 * 60 + 30, end: 9 * 60 + 20 },   // 1교시: 08:30-09:20 (rowIndex 0)
      { start: 9 * 60 + 30, end: 10 * 60 + 20 },  // 2교시: 09:30-10:20 (rowIndex 1)
      { start: 10 * 60 + 30, end: 11 * 60 + 20 }, // 3교시: 10:30-11:20 (rowIndex 2)
      { start: 11 * 60 + 30, end: 12 * 60 + 20 }, // 4교시: 11:30-12:20 (rowIndex 3)
      { start: 12 * 60 + 20, end: 13 * 60 + 20 }, // 점심시간: 12:20-13:20 (rowIndex 4)
      { start: 13 * 60 + 20, end: 14 * 60 + 10 }, // 5교시: 13:20-14:10 (rowIndex 5)
      { start: 14 * 60 + 20, end: 15 * 60 + 10 }, // 6교시: 14:20-15:10 (rowIndex 6)
      { start: 15 * 60 + 20, end: 16 * 60 + 10 }, // 7교시: 15:20-16:10 (rowIndex 7)
    ];

    // 현재 시간의 Y 위치 계산
    const getCurrentTimeY = () => {
      if (currentDay < 1 || currentDay > 5) return null; // 월~금만
      
      for (let i = 0; i < periodTimes.length; i++) {
        const period = periodTimes[i];
        if (currentTime >= period.start && currentTime <= period.end) {
          // 교시 내에서 진행률 계산
          const totalMinutes = period.end - period.start;
          const passedMinutes = currentTime - period.start;
          const progress = totalMinutes > 0 ? passedMinutes / totalMinutes : 0;
          
          // Y 위치 반환 (행 인덱스와 진행률)
          return { rowIndex: i, progress };
        }
      }
      
      // 교시 사이의 시간 처리
      for (let i = 0; i < periodTimes.length - 1; i++) {
        const periodEnd = periodTimes[i].end;
        const nextPeriodStart = periodTimes[i + 1].start;
        
        if (currentTime > periodEnd && currentTime < nextPeriodStart) {
          // 쉬는 시간의 진행률 계산
          const totalBreakMinutes = nextPeriodStart - periodEnd;
          const passedBreakMinutes = currentTime - periodEnd;
          const breakProgress = totalBreakMinutes > 0 ? passedBreakMinutes / totalBreakMinutes : 0;
          
          return { rowIndex: i, progress: 1 + breakProgress }; // 1.0 이상은 교시 사이
        }
      }
      
      return null;
    };

    const timeY = getCurrentTimeY();

    return (
      <div className="timetable-grid">
        {periods.map((p, pIdx) => {
          // 점심시간은 4교시(pIdx === 3) 다음에 삽입
          if (pIdx === 3) {
            return (
              <React.Fragment key={`period-group-${p}`}>
                {/* 4교시 행 */}
                <div className="timetable-cell period">4</div>
                {days.map((_, dIdx) => {
                  const lesson = schedule[3]?.[dIdx]; // 4교시는 인덱스 3
                  const isCurrentTimeCell = timeY && timeY.rowIndex === 3 && (currentDay - 1 === dIdx);
                  const subjectColor = lesson && lesson[0] ? getSubjectColor(lesson[0]) : '';
                  return (
                    <div 
                      key={`4-${dIdx}`} 
                      className={`timetable-cell ${isCurrentTimeCell ? 'current-time-cell' : ''}`}
                      style={{
                        ...(isCurrentTimeCell && timeY && timeY.progress !== undefined ? {
                          position: 'relative',
                          '--time-progress': timeY.progress < 1 ? timeY.progress : timeY.progress - 1
                        } : {}),
                        ...(subjectColor ? { backgroundColor: subjectColor } : {})
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
                })}
                {/* 점심시간 행 */}
                <div className="timetable-cell period lunch">점심</div>
                {days.map((_, dIdx) => {
                  const isCurrentTimeCell = timeY && timeY.rowIndex === 4 && (currentDay - 1 === dIdx);
                  return (
                    <div 
                      key={`lunch-${dIdx}`} 
                      className={`timetable-cell lunch-cell ${isCurrentTimeCell ? 'current-time-cell' : ''}`}
                      style={isCurrentTimeCell && timeY && timeY.progress !== undefined ? {
                        position: 'relative',
                        '--time-progress': timeY.progress < 1 ? timeY.progress : timeY.progress - 1
                      } as React.CSSProperties : undefined}
                    >
                      점심시간
                    </div>
                  );
                })}
                {/* 5교시 행 */}
                <div className="timetable-cell period">5</div>
                {days.map((_, dIdx) => {
                  const lesson = schedule[4]?.[dIdx]; // 5교시는 인덱스 4
                  const isCurrentTimeCell = timeY && timeY.rowIndex === 5 && (currentDay - 1 === dIdx);
                  const subjectColor = lesson && lesson[0] ? getSubjectColor(lesson[0]) : '';
                  return (
                    <div 
                      key={`5-${dIdx}`} 
                      className={`timetable-cell ${isCurrentTimeCell ? 'current-time-cell' : ''}`}
                      style={{
                        ...(isCurrentTimeCell && timeY && timeY.progress !== undefined ? {
                          position: 'relative',
                          '--time-progress': timeY.progress < 1 ? timeY.progress : timeY.progress - 1
                        } : {}),
                        ...(subjectColor ? { backgroundColor: subjectColor } : {})
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
                })}
              </React.Fragment>
            );
          }
          
          // 4교시와 5교시는 이미 처리됨
          if (pIdx === 3 || pIdx === 4) return null;
          
          // 점심시간 이후 교시는 인덱스 조정
          // 원래 데이터: schedule[0]=1교시, [1]=2교시, [2]=3교시, [3]=4교시, [4]=5교시, [5]=6교시, [6]=7교시, [7]=8교시
          // 표시할 교시: 1, 2, 3, 4, 점심, 5, 6, 7
          // 실제 데이터 구조 확인 결과:
          // 1교시(pIdx=0) -> schedule[0] ✓
          // 2교시(pIdx=1) -> schedule[1] ✓
          // 3교시(pIdx=2) -> schedule[2] ✓
          // 4교시(pIdx=3) -> schedule[3] ✓ (특별 처리)
          // 점심시간 (특별 처리)
          // 5교시(pIdx=4) -> schedule[4] ✓ (특별 처리)
          // 6교시(pIdx=5) -> schedule[5] (원래 6교시 데이터)
          // 7교시(pIdx=6) -> schedule[6] (원래 7교시 데이터)
          const scheduleIdx = pIdx;
          
          // pIdx에 따른 실제 rowIndex 매핑
          // 실제 렌더링 순서: 1, 2, 3, 4, 점심, 5, 6, 7
          // 1교시(pIdx=0) -> rowIndex 0
          // 2교시(pIdx=1) -> rowIndex 1
          // 3교시(pIdx=2) -> rowIndex 2
          // 4교시(pIdx=3) -> rowIndex 3 (특별 처리됨)
          // 점심시간 -> rowIndex 4 (특별 처리됨)
          // 5교시(pIdx=4) -> rowIndex 5 (특별 처리됨)
          // 6교시(pIdx=5) -> rowIndex 6
          // 7교시(pIdx=6) -> rowIndex 7
          // pIdx 0,1,2는 그대로, pIdx 5,6은 점심시간 때문에 +1
          const actualRowIndex = pIdx < 3 ? pIdx : pIdx + 1;
          
          return (
            <React.Fragment key={p}>
              <div className="timetable-cell period">{p}</div>
              {days.map((_, dIdx) => {
                const lesson = schedule[scheduleIdx]?.[dIdx];
                const isCurrentTimeCell = timeY && timeY.rowIndex === actualRowIndex && (currentDay - 1 === dIdx);
                const subjectColor = lesson && lesson[0] ? getSubjectColor(lesson[0]) : '';
                return (
                  <div 
                    key={`${p}-${dIdx}`} 
                    className={`timetable-cell ${isCurrentTimeCell ? 'current-time-cell' : ''}`}
                    style={{
                      ...(isCurrentTimeCell && timeY && timeY.progress !== undefined ? {
                        position: 'relative',
                        '--time-progress': timeY.progress < 1 ? timeY.progress : timeY.progress - 1
                      } : {}),
                      ...(subjectColor ? { backgroundColor: subjectColor } : {})
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
              })}
            </React.Fragment>
          );
        })}
      </div>
    );
  };

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.teacher-search-container')) {
        setShowTeacherDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 마우스 위치 추적
  useEffect(() => {
    // if (activeTab !== 'meal') {
    //   targetPosRef.current = null;
    //   return;
    // }

    const handleMouseMove = (e: Event) => {
      const mouseEvent = e as MouseEvent;
      const container = document.querySelector('.school-widget-container');
      if (!container) return;
      
      const rect = container.getBoundingClientRect();
      targetPosRef.current = {
        x: mouseEvent.clientX - rect.left,
        y: mouseEvent.clientY - rect.top
      };
    };

    const handleMouseLeave = () => {
      targetPosRef.current = null;
    };

    const container = document.querySelector('.school-widget-container');
    if (container) {
      container.addEventListener('mousemove', handleMouseMove as EventListener);
      container.addEventListener('mouseleave', handleMouseLeave);
    }

    return () => {
      if (container) {
        container.removeEventListener('mousemove', handleMouseMove as EventListener);
        container.removeEventListener('mouseleave', handleMouseLeave);
      }
    };
  }, []);

  // 급식 위젯에서 고양이가 돌아다니도록
  useEffect(() => {
    if (!catEnabled) {
      setCatState(null);
      return;
    }

    let animationFrameId: number;
    let lastMoveTime = performance.now();
    let lastFrameTime = performance.now();
    let isRunning = true;
    const frameDelay = 150; // 애니메이션 프레임 전환 속도 (ms)
    const moveSpeed = 30; // 픽셀/초 이동 속도

    // 고양이 초기화 (이미 있으면 초기화하지 않음)
    // 랜덤 목표 지점 상태 관리
    let randomTarget: { x: number; y: number } | null = null;
    let idleStartTime: number | null = null;
    let idleDuration: number = 0;

    // 고양이 초기화 (이미 있으면 초기화하지 않음)
    const initCat = () => {
      setCatState(prev => {
        if (prev) return prev; // 이미 존재하면 유지
        
        const container = document.querySelector('.school-widget-container');
        if (!container) return null;
        
        const rect = container.getBoundingClientRect();
        // 고양이 중심점 기준 경계 내에서 랜덤 위치 생성
        const halfSize = catSize / 2;
        const minCenterX = 10 + halfSize;
        const maxCenterX = rect.width - 10 - halfSize;
        const minCenterY = 80 + halfSize;
        const maxCenterY = rect.height - 10 - halfSize;
        
        // 중심점 위치 생성
        const centerX = Math.random() * (maxCenterX - minCenterX) + minCenterX;
        const centerY = Math.random() * (maxCenterY - minCenterY) + minCenterY;
        
        // 중심점에서 왼쪽 상단 모서리 위치로 변환
        return {
          x: centerX - halfSize,
          y: centerY - halfSize,
          direction: 'right' as const,
          action: 'walking' as const,
          frame: 0
        };
      });
    };

    // 랜덤 목표 지점 생성 (고양이 중심점 기준)
    const getRandomTarget = () => {
      const container = document.querySelector('.school-widget-container');
      if (!container) return null;
      
      const rect = container.getBoundingClientRect();
      const halfSize = catSize / 2;
      const minCenterX = 10 + halfSize;
      const maxCenterX = rect.width - 10 - halfSize;
      const minCenterY = 80 + halfSize;
      const maxCenterY = rect.height - 10 - halfSize;
      
      return {
        x: Math.random() * (maxCenterX - minCenterX) + minCenterX,
        y: Math.random() * (maxCenterY - minCenterY) + minCenterY
      };
    };

    // 고양이 초기화 (3초 후)
    const initTimeout = setTimeout(initCat, 3000);

    const animate = (currentTime: number) => {
      // 이동용 deltaTime (매 프레임 계산)
      const moveDeltaTime = currentTime - lastMoveTime;
      lastMoveTime = currentTime; // 항상 업데이트
      
      // 애니메이션 프레임용 deltaTime
      const frameDeltaTime = currentTime - lastFrameTime;
      const shouldUpdateFrame = frameDeltaTime >= frameDelay;
      
      if (shouldUpdateFrame) {
        lastFrameTime = currentTime;
      }
      
      const deltaSeconds = moveDeltaTime / 1000; // 초 단위로 변환
      
      setCatState(prev => {
        if (!prev) return null;

        const container = document.querySelector('.school-widget-container');
        if (!container) return prev;
        
        const rect = container.getBoundingClientRect();
        // 고양이 중심점 기준 경계 설정
        const halfSize = catSize / 2;
        const bounds = { 
          minX: 10 + halfSize, 
          maxX: rect.width - 10 - halfSize, 
          minY: 80 + halfSize, 
          maxY: rect.height - 10 - halfSize 
        };

        let newState = { ...prev };
        const moveDistance = moveSpeed * deltaSeconds; // 이번 프레임에서 이동할 거리
        
        // 고양이의 중심점 계산
        const catCenterX = newState.x + halfSize;
        const catCenterY = newState.y + halfSize;

        // 액션에 따른 처리
        const currentTargetPos = targetPosRef.current;
        
        // 목표 지점 결정 (마우스 위치 또는 랜덤 위치)
        let targetX: number, targetY: number;
        let isRandomWandering = false;

        if (currentTargetPos) {
          // 마우스가 위젯 안에 있으면 마우스 따라가기
          targetX = currentTargetPos.x;
          targetY = currentTargetPos.y;
          // 마우스 추적 시 랜덤 타겟 및 대기 상태 초기화
          randomTarget = null;
          idleStartTime = null;
        } else {
          // 마우스가 밖으로 나가면 랜덤 배회
          isRandomWandering = true;

          // 대기 중인지 확인
          if (idleStartTime !== null) {
            if (currentTime - idleStartTime < idleDuration) {
              // 아직 대기 중이면 움직이지 않음 (상태 유지)
              // 대기 중 랜덤 행동 애니메이션 처리는 아래에서 계속됨
            } else {
              // 대기 끝, 새로운 목표 설정
              idleStartTime = null;
              randomTarget = getRandomTarget();
            }
          }

          if (!randomTarget && !idleStartTime) {
            randomTarget = getRandomTarget();
          }
          
          if (randomTarget) {
            targetX = randomTarget.x;
            targetY = randomTarget.y;
          } else {
            // 대기 중이거나 목표가 없으면 현재 위치 유지
            targetX = catCenterX;
            targetY = catCenterY;
          }
        }

        // 목표 위치를 경계 내로 제한 (마우스 위치는 중심점 기준)
        const clampedTargetX = Math.max(bounds.minX, Math.min(bounds.maxX, targetX));
        const clampedTargetY = Math.max(bounds.minY, Math.min(bounds.maxY, targetY));
        
        // 고양이 중심점과 목표 위치의 거리 계산
        const dx = clampedTargetX - catCenterX;
        const dy = clampedTargetY - catCenterY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // 목표 도달 임계값 (랜덤 배회 시 조금 더 여유롭게)
        const arrivalThreshold = isRandomWandering ? 5 : 2;

        if (newState.action === 'walking') {
          // 벡터 기반 속도 제어로 이동
          if (distance <= arrivalThreshold || (moveDistance >= distance && distance < 10)) {
            // 목표 위치에 도달
            if (isRandomWandering) {
              // 랜덤 배회 중 목표 도달 시 대기 모드로 전환
              if (idleStartTime === null) {
                idleStartTime = currentTime;
                idleDuration = 2000 + Math.random() * 4000; // 2~6초 대기
                randomTarget = null;

                // 랜덤 행동 결정 (앉기, 핥기, 눕기)
                const rand = Math.random();
                let nextAction: 'walking' | 'sitting' | 'licking' | 'lying' = 'sitting';
                
                if (rand < 0.4) nextAction = 'sitting';
                else if (rand < 0.7) nextAction = 'licking';
                else nextAction = 'lying';

                newState.action = nextAction;
                newState.frame = 0;
                newState.actionPhase = 'forward';
                newState.holdStartTime = currentTime;
              }
            } else {
              // 마우스 추적 중 목표 도달 -> 멈춤 (앉기)
              // 도착하면 앉기 (4번째 프레임 유지)
              newState.action = 'sitting';
              newState.frame = 3; // 4번째 프레임 (0-indexed)
              newState.actionPhase = 'hold';
              newState.holdStartTime = currentTime;
            }
            
            // 위치 보정
            const newCenterX = clampedTargetX;
            const newCenterY = clampedTargetY;
            newState.x = newCenterX - halfSize;
            newState.y = newCenterY - halfSize;
            
          } else {
            // 이동 중 (걷기)
            // 대기 중이 아닐 때만 이동
            if (!isRandomWandering || idleStartTime === null) {
              const moveX = (dx / distance) * moveDistance;
              const moveY = (dy / distance) * moveDistance;
              
              const newCenterX = Math.max(bounds.minX, Math.min(bounds.maxX, catCenterX + moveX));
              const newCenterY = Math.max(bounds.minY, Math.min(bounds.maxY, catCenterY + moveY));
              
              // 중심점에서 왼쪽 상단 모서리 위치로 변환
              newState.x = newCenterX - halfSize;
              newState.y = newCenterY - halfSize;
              
              // 방향 결정 (히스테리시스 적용)
              const absDx = Math.abs(dx);
              const absDy = Math.abs(dy);
              const currentDir = newState.direction;
              const isHorizontal = currentDir === 'left' || currentDir === 'right';
              
              // 현재 방향을 유지하려는 성향 (1.5배 가중치)
              if (isHorizontal) {
                if (absDy > absDx * 1.5) {
                  newState.direction = dy > 0 ? 'down' : 'up';
                } else {
                  newState.direction = dx > 0 ? 'right' : 'left';
                }
              } else {
                if (absDx > absDy * 1.5) {
                  newState.direction = dx > 0 ? 'right' : 'left';
                } else {
                  newState.direction = dy > 0 ? 'down' : 'up';
                }
              }
              
              // 이동 중 가끔 액션 수행 (프레임 업데이트 시에만 체크) - 랜덤 배회 중에는 제외
              if (!isRandomWandering && shouldUpdateFrame && Math.random() < 0.02) {
                 // 걷다가 가끔 멈춰서 핥거나 앉기
                 const rand = Math.random();
                 if (rand < 0.5) {
                   newState.action = 'licking';
                   newState.frame = 0;
                   newState.actionPhase = undefined;
                 } else {
                   newState.action = 'sitting';
                   newState.frame = 0;
                   newState.actionPhase = 'forward';
                 }
              }
            }
          }
        } else {
          // 액션 애니메이션 처리 (walking 아님)
          
          // 마우스가 다시 이동하면 걷기로 전환 (마우스 추적 모드일 때만)
          if (currentTargetPos) {
             // 고양이 중심점과 목표 위치(마우스)의 거리 계산
             const dx = currentTargetPos.x - catCenterX;
             const dy = currentTargetPos.y - catCenterY;
             const distance = Math.sqrt(dx * dx + dy * dy);
             
             // 마우스가 이동했으면 (거리가 충분히 멀면) 걷기로 전환
             if (distance > 10) {
               newState.action = 'walking';
               newState.actionPhase = undefined;
               newState.holdStartTime = undefined;
             }
          } else if (isRandomWandering && idleStartTime === null) {
             // 랜덤 배회 모드인데 대기 시간이 끝났거나 설정되지 않았으면 걷기로 전환
             // (위의 로직에서 idleStartTime이 null이면 randomTarget이 설정됨)
             if (randomTarget) {
                newState.action = 'walking';
                newState.actionPhase = undefined;
                newState.holdStartTime = undefined;
             }
          }
          
          // 액션 애니메이션 처리 (프레임 업데이트 시에만)
          if (shouldUpdateFrame) {
            const isForwardHoldReverse = newState.action === 'sitting' || newState.action === 'lying';
            
            if (isForwardHoldReverse) {
              // 앉기/눕기: forward → hold → reverse 순서
              if (!newState.actionPhase) {
                newState.actionPhase = 'forward';
                newState.frame = 0;
              }

              if (newState.actionPhase === 'forward') {
                // 1→2→3→4 순서로 진행
                if (newState.frame < 3) {
                  newState.frame += 1;
                } else {
                  // 4번 프레임 도달, 유지 단계로
                  newState.actionPhase = 'hold';
                  newState.holdStartTime = currentTime;
                }
              } else if (newState.actionPhase === 'hold') {
                // 4번 프레임 유지
                // 마우스가 있으면 마우스가 이동할 때까지 유지 (자동 전환 안 함)
                // 마우스가 없으면(랜덤 배회) 일정 시간 후 reverse로 전환 (랜덤 배회 로직에서 처리됨)
                // 하지만 여기서도 안전장치로 처리 가능
                
                // 랜덤 배회 중 대기 시간이 끝나면 reverse로 전환하여 일어남
                if (isRandomWandering && idleStartTime !== null && currentTime - idleStartTime >= idleDuration) {
                   newState.actionPhase = 'reverse';
                   newState.frame = 3;
                }
                
                // 마우스 추적 모드에서 3초 이상 지나면 가끔 다른 행동 (예: 눕기 -> 앉기) - 복잡하니 생략
              } else if (newState.actionPhase === 'reverse') {
                // 4→3→2→1 역순으로 진행
                if (newState.frame > 0) {
                  newState.frame -= 1;
                } else {
                  // 애니메이션 완료 후 걷기로 전환
                  newState.action = 'walking';
                  newState.actionPhase = undefined;
                  newState.holdStartTime = undefined;
                  // 방향 랜덤 변경
                  newState.direction = ['right', 'left', 'up', 'down'][Math.floor(Math.random() * 4)] as 'down' | 'right' | 'up' | 'left';
                }
              }
            } else if (newState.action === 'licking') {
               // licking: loop 상태로 지속
               if (!newState.actionPhase) {
                  newState.actionPhase = 'loop';
                  newState.holdStartTime = currentTime;
                  newState.frame = 0;
               }

               if (newState.actionPhase === 'loop') {
                  newState.frame = (newState.frame + 1) % 4;
                  
                  // 랜덤 배회 중 대기 시간이 끝나면 걷기로 전환
                  if (isRandomWandering && idleStartTime !== null && currentTime - idleStartTime >= idleDuration) {
                      newState.action = 'walking';
                      newState.actionPhase = undefined;
                      newState.holdStartTime = undefined;
                      newState.direction = ['right', 'left', 'up', 'down'][Math.floor(Math.random() * 4)] as 'down' | 'right' | 'up' | 'left';
                  }
                  
                  // 마우스 추적 모드에서도 3초 지나면 걷기로 전환 (너무 오래 핥지 않게)
                  if (!isRandomWandering && newState.holdStartTime && currentTime - newState.holdStartTime >= 3000) {
                      newState.action = 'walking';
                      newState.actionPhase = undefined;
                      newState.holdStartTime = undefined;
                  }
               }
            } else {
              // 기타 액션 (걷기 애니메이션)
              newState.frame = (newState.frame + 1) % 4;
            }
          }
        }

        return newState;
      });
      
      if (isRunning) {
        animationFrameId = requestAnimationFrame(animate);
      }
    };

    animationFrameId = requestAnimationFrame(animate);

    return () => {
      isRunning = false;
      clearTimeout(initTimeout);
      cancelAnimationFrame(animationFrameId);
    };
  }, [catEnabled]);

  return (
    <div className="school-widget-container">
      <div className="tab-bar">
        <button 
          className={activeTab === 'meal' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('meal')}
        >
          급식
        </button>
        <button 
          className={activeTab === 'timetable' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('timetable')}
        >
          시간표
        </button>
        <button 
          className={activeTab === 'attendance' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('attendance')}
        >
          출결
        </button>
        <button 
          className={activeTab === 'points' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('points')}
        >
          상벌점
        </button>
        <button 
          className={activeTab === 'settings' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('settings')}
        >
          설정
        </button>
      </div>

      <div className="tab-content">
        {activeTab === 'meal' && (
          <div className="meal-section">
            <div className="section-header">
              <h2>오늘의 급식</h2>
              <span className="date">{new Date().toLocaleDateString()}</span>
            </div>
            {loadingStates.meal ? (
              <div className="loading">로딩 중...</div>
            ) : (
              <div className="meal-items-container">
                <div className="meal-item">
                  <div className="meal-type">중식</div>
                  <div className="meal-menu">{mealInfo.lunch}</div>
                </div>
                <div className="meal-item">
                  <div className="meal-type">석식</div>
                  <div className="meal-menu">{mealInfo.dinner}</div>
                </div>
              </div>
            )}

          </div>
        )}
        
        {catEnabled && catState && (
          <div 
            className="cat-sprite"
            onClick={(e) => {
              // 클릭 위치를 컨테이너 기준 좌표로 변환
              const container = document.querySelector('.school-widget-container');
              if (!container) return;
              
              const rect = container.getBoundingClientRect();
              const clickX = e.clientX - rect.left;
              const clickY = e.clientY - rect.top;
              
              // 픽셀 퍼펙트 히트 테스트
              const isHit = isPixelHit(
                clickX,
                clickY,
                catState.x,
                catState.y,
                catSize,
                catState.direction,
                catState.action,
                catState.frame
              );
              
              if (!isHit) {
                return; // 투명 영역 클릭 무시
              }
              
              // 클릭 시 1픽셀씩 커지기
              const newSize = catSize + 1;
              setCatSize(newSize);
              localStorage.setItem('schoolCatSize', newSize.toString());
              
              setCatState(prev => {
                if (!prev) return null;
                // 클릭 시 앉거나 눕기 (50% 확률)
                const action = Math.random() < 0.5 ? 'sitting' : 'lying';
                return {
                  ...prev,
                  action: action as 'sitting' | 'lying',
                  frame: 0,
                  actionPhase: 'forward',
                  holdStartTime: undefined
                };
              });
            }}
            style={{
              position: 'absolute',
              left: `${catState.x}px`,
              top: `${catState.y}px`,
              width: `${catSize}px`,
              height: `${catSize}px`,
              backgroundImage: `url(${new URL('./asset/stardew-cat.png', import.meta.url).href})`,
              backgroundSize: `${catSize * 4}px ${catSize * 8}px`,
              backgroundPosition: `-${catState.frame * catSize}px -${getCatSpriteRow(catState.direction, catState.action) * catSize}px`,
              imageRendering: 'pixelated',
              zIndex: 1000,
              cursor: 'pointer',
              pointerEvents: 'auto', // 클릭 이벤트를 받기 위해
            }}
          />
        )}


        {activeTab === 'timetable' && (
          <div className="timetable-section">
            {renderTimetable()}
            <div className="timetable-hover-area"></div>
            <div className="timetable-search-hover">
              <div className="teacher-search-container">
                <input 
                  type="text" 
                  value={teacherSearch} 
                  onChange={(e) => handleTeacherSearchChange(e.target.value)}
                  onFocus={() => setShowTeacherDropdown(true)}
                  onKeyDown={handleKeyDown}
                  placeholder="선생님 검색..."
                  className="search-input"
                />
                {showTeacherDropdown && filteredTeachers.length > 0 && (
                  <div className="teacher-dropdown">
                    {filteredTeachers.map((teacher, index) => (
                      <div
                        key={teacher}
                        className={`teacher-dropdown-item ${index === highlightedIndex ? 'highlighted' : ''} ${teacher === selectedTeacher ? 'selected' : ''}`}
                        onClick={() => handleTeacherSelect(teacher)}
                        onMouseEnter={() => setHighlightedIndex(index)}
                      >
                        {teacher}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'attendance' && (
          <div className="attendance-section">
            <div className="controls">
              <button onClick={() => fetchAttendance(true)} className="refresh-btn-small">새로고침</button>
            </div>
            {loadingStates.attendance ? (
              <div className="loading">로딩 중...</div>
            ) : latecomers.length === 0 ? (
              <div className="empty-message">출결 데이터가 없습니다</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>학생정보</th>
                    <th>등교시간</th>
                    <th>출결사항</th>
                  </tr>
                </thead>
                <tbody>
                  {latecomers.map((l, i) => {
                    // 학생정보에서 "*번 ***" 형식만 추출
                    const match = l.student_info.match(/(\d+)번\s+(.+)/);
                    const displayInfo = match ? `${match[1]}번\n${match[2]}` : l.student_info;
                    return (
                      <tr key={i}>
                        <td>{displayInfo}</td>
                        <td>{l.arrival_time}</td>
                        <td>{l.attendance_status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'points' && (
          <div className="points-section">
            <div className="controls">
              <button onClick={() => fetchPoints(true)} className="refresh-btn-small">새로고침</button>
            </div>
            {loadingStates.points ? (
              <div className="loading">로딩 중...</div>
            ) : points.length === 0 ? (
              <div className="empty-message">상벌점 데이터가 없습니다</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>학생정보</th>
                    <th>상점</th>
                    <th>벌점</th>
                    <th>상쇄</th>
                    <th>총점</th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((p, i) => {
                    // 학생정보에서 "*번 ***" 형식만 추출
                    const match = p.student_info.match(/(\d+)번\s+(.+)/);
                    const displayInfo = match ? `${match[1]}번 ${match[2]}` : p.student_info;
                    return (
                      <tr key={i}>
                        <td>{displayInfo}</td>
                        <td className="reward">{p.reward}</td>
                        <td className="penalty">{p.penalty}</td>
                        <td>{p.offset}</td>
                        <td className="total">{p.total}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="settings-section">
            <div className="section-header">
              <h2>설정</h2>
            </div>
            
            <div className="settings-group">
              <h3>위젯 설정</h3>
              <div className="setting-item">
                <label>
                  <input
                    type="checkbox"
                    checked={schoolWidgetPinned}
                    onChange={(e) => setSchoolWidgetPinned(e.target.checked)}
                  />
                  <span>학교 위젯 고정 (핀)</span>
                </label>
                <div className="setting-description">
                  학교 위젯을 고정하면 크기 조절이 가능합니다.
                </div>
              </div>
              <div className="setting-item">
                <label>
                  <input
                    type="checkbox"
                    checked={catEnabled}
                    onChange={(e) => {
                      setCatEnabled(e.target.checked);
                      localStorage.setItem('schoolCatEnabled', e.target.checked.toString());
                      if (!e.target.checked) {
                        setCatState(null);
                      }
                    }}
                  />
                  <span>급식 탭 고양이 표시</span>
                </label>
                <div className="setting-description">
                  급식 탭에서 고양이가 돌아다닙니다.
                </div>
              </div>
              <div className="setting-item">
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span>고양이 크기: {catSize}px</span>
                  <button
                    onClick={() => {
                      setCatSize(32);
                      localStorage.setItem('schoolCatSize', '32');
                    }}
                    style={{
                      padding: '4px 12px',
                      fontSize: '12px',
                      backgroundColor: '#f0f0f0',
                      border: '1px solid #ccc',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    크기 초기화
                  </button>
                </div>
              </div>
            </div>

            <div className="settings-group">
              <h3>시간표</h3>
              <div className="setting-item">
                <label htmlFor="default-teacher">기본 선생님</label>
                <select
                  id="default-teacher"
                  value={defaultTeacher}
                  onChange={(e) => setDefaultTeacher(e.target.value)}
                  className="setting-select"
                >
                  <option value="">선택 안 함</option>
                  {timetableData?.teachers.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <div className="setting-description">
                  시간표 탭을 열 때 기본으로 표시할 선생님을 선택합니다.
                </div>
              </div>
            </div>

            <div className="settings-group">
              <h3>학년/반</h3>
              <div className="setting-item setting-item-row">
                <div className="setting-input-group">
                  <label htmlFor="settings-grade">학년</label>
                  <input
                    id="settings-grade"
                    type="number"
                    value={grade}
                    onChange={(e) => setGrade(e.target.value)}
                    min="1"
                    max="3"
                    className="setting-input"
                  />
                </div>
                <div className="setting-input-group">
                  <label htmlFor="settings-class">반</label>
                  <input
                    id="settings-class"
                    type="number"
                    value={classNum}
                    onChange={(e) => setClassNum(e.target.value)}
                    min="1"
                    max="20"
                    className="setting-input"
                  />
                </div>
                <div className="setting-description">
                  출결 및 상벌점 조회에 사용되는 학년과 반입니다.
                </div>
              </div>
            </div>

            <div className="settings-group">
              <h3>학교 정보</h3>
              <div className="setting-item">
                <label htmlFor="settings-region-code">지역 코드</label>
                <input
                  id="settings-region-code"
                  type="text"
                  value={regionCode}
                  onChange={(e) => setRegionCode(e.target.value)}
                  placeholder="예: C10"
                  className="setting-input"
                  style={{ maxWidth: '200px' }}
                />
                <div className="setting-description">
                  NEIS API에서 사용하는 지역 교육청 코드입니다. (예: 서울 C10, 경기 J10)
                </div>
              </div>
              <div className="setting-item">
                <label htmlFor="settings-school-code">학교 코드</label>
                <input
                  id="settings-school-code"
                  type="text"
                  value={schoolCode}
                  onChange={(e) => setSchoolCode(e.target.value)}
                  placeholder="예: 7150451"
                  className="setting-input"
                  style={{ maxWidth: '200px' }}
                />
                <div className="setting-description">
                  NEIS API에서 사용하는 학교 코드입니다. 학교 정보 검색을 통해 확인할 수 있습니다.
                </div>
              </div>
            </div>

            <div className="settings-actions">
              <button onClick={saveSettings} className="save-btn">설정 저장</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SchoolWidget />
  </React.StrictMode>
);

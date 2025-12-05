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

// 고양이 종류 정의 (rows: 스프라이트 시트 행 수, 보라/하양이/까망이는 더미 9행 포함)
const CAT_TYPES = [
  { id: 'default', name: '기본', sprite: 'stardew-cat.png', rows: 8 },
  { id: 'orange', name: '주황이', sprite: 'stardew-cat-orange.png', rows: 8 },
  { id: 'gray', name: '회색이', sprite: 'stardew-cat-gray.png', rows: 8 },
  { id: 'black', name: '까망이', sprite: 'stardew-cat-black.png', rows: 9 },
  { id: 'white', name: '하양이', sprite: 'stardew-cat-white.png', rows: 9 },
  { id: 'purple', name: '보라', sprite: 'stardew-cat-purple.png', rows: 9 },
] as const;

type CatTypeId = typeof CAT_TYPES[number]['id'];

// 고양이 행동 상태 타입 (State Machine)
type CatDirection = 'down' | 'right' | 'up' | 'left';
type CatActionPhase = 'enter' | 'hold' | 'exit';

interface CatBehaviorIdle {
  type: 'idle';
}

interface CatBehaviorWalking {
  type: 'walking';
  target: { x: number; y: number } | null; // null이면 마우스 따라가기
}

interface CatBehaviorSitting {
  type: 'sitting';
  phase: CatActionPhase;
  phaseStartTime: number;
  actionStartTime: number; // 액션 시작 시간 (최소 유지 시간 체크용)
}

interface CatBehaviorLicking {
  type: 'licking';
  startTime: number;
  duration: number; // 핥기 지속 시간 (ms)
}

interface CatBehaviorLying {
  type: 'lying';
  phase: CatActionPhase;
  phaseStartTime: number;
  actionStartTime: number; // 액션 시작 시간 (최소 유지 시간 체크용)
}

type CatBehavior = CatBehaviorIdle | CatBehaviorWalking | CatBehaviorSitting | CatBehaviorLicking | CatBehaviorLying;

interface CatState {
  id: CatTypeId;
  x: number;
  y: number;
  direction: CatDirection;
  behavior: CatBehavior;
  frame: number;
}

export default function SchoolWidget() {
  const [activeTab, setActiveTab] = useState<Tab>('meal');
  const [timetableData, setTimetableData] = useState<TimetableData | null>(null);
  const [selectedTeacher, setSelectedTeacher] = useState<string>('');
  const [teacherSearch, setTeacherSearch] = useState('');
  const [mealInfo, setMealInfo] = useState<MealInfo>({ lunch: 'Loading...', dinner: 'Loading...' });
  const [latecomers, setLatecomers] = useState<Latecomer[]>([]);
  const [points, setPoints] = useState<PointStatus[]>([]);
  
  // 여러 고양이 상태 관리 - useRef로 성능 최적화
  const catStatesRef = useRef<Map<CatTypeId, CatState>>(new Map());
  const catElementsRef = useRef<Map<CatTypeId, HTMLDivElement | null>>(new Map());
  const [visibleCats, setVisibleCats] = useState<Set<CatTypeId>>(new Set()); // 렌더링 트리거용
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
  
  // 활성화된 고양이 목록 (여러 고양이 지원)
  const [enabledCats, setEnabledCats] = useState<CatTypeId[]>(() => {
    const saved = localStorage.getItem('schoolEnabledCats');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return ['default'];
      }
    }
    // 기존 catEnabled 설정이 있으면 마이그레이션
    const oldEnabled = localStorage.getItem('schoolCatEnabled');
    if (oldEnabled === 'false') {
      return [];
    }
    return ['default'];
  });
  
  const [catSize, setCatSize] = useState(() => parseInt(localStorage.getItem('schoolCatSize') || '32', 10));
  
  // 픽셀 데이터 캐싱을 위한 ref (고양이 종류별로 캐싱)
  const spritePixelDataRef = useRef<Map<string, Map<string, ImageData>>>(new Map());
  const spriteImagesRef = useRef<Map<CatTypeId, HTMLImageElement>>(new Map());

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

  // 고양이 스프라이트 행 번호 계산 (새로운 타입 시스템 사용)
  const getCatSpriteRow = (direction: CatDirection, behaviorType: CatBehavior['type']): number => {
    if (behaviorType === 'walking' || behaviorType === 'idle') {
      switch (direction) {
        case 'down': return 0;  // 1행: 아래로 걷기
        case 'right': return 1; // 2행: 오른쪽 걷기
        case 'up': return 2;    // 3행: 위로 걷기
        case 'left': return 3;  // 4행: 왼쪽 걷기
      }
    } else {
      switch (behaviorType) {
        case 'sitting': return 4;   // 5행: 앉기
        case 'licking': return 5;   // 6행: 손핥기
        case 'lying': return 6;     // 7행: 오른쪽 보다가 바닥에 눕기
        default: return 1;
      }
    }
  };

  // 스프라이트 이미지 로드 및 픽셀 데이터 캐싱 (모든 고양이 종류)
  useEffect(() => {
    const loadSpriteImage = (catType: typeof CAT_TYPES[number]) => {
      const img = new Image();
      img.src = new URL(`./asset/${catType.sprite}`, import.meta.url).href;
      img.onload = () => {
        spriteImagesRef.current.set(catType.id, img);
        
        // 캔버스 생성 및 픽셀 데이터 추출
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        // 스프라이트 시트 크기: rows행 4열, 각 프레임 32x32
        const frameWidth = 32;
        const frameHeight = 32;
        const cols = 4;
        const rows = catType.rows; // 고양이별 행 수 사용
        
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        
        // 각 프레임의 픽셀 데이터 캐싱
        const catPixelData = new Map<string, ImageData>();
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            ctx.clearRect(0, 0, frameWidth, frameHeight);
            ctx.drawImage(
              img,
              col * frameWidth, row * frameHeight, frameWidth, frameHeight,
              0, 0, frameWidth, frameHeight
            );
            
            const imageData = ctx.getImageData(0, 0, frameWidth, frameHeight);
            const key = `${row}-${col}`;
            catPixelData.set(key, imageData);
          }
        }
        spritePixelDataRef.current.set(catType.id, catPixelData);
      };
      img.onerror = () => {
        console.error(`Failed to load cat sprite image: ${catType.sprite}`);
      };
    };
    
    // 모든 고양이 스프라이트 로드
    CAT_TYPES.forEach(catType => loadSpriteImage(catType));
  }, []);

  // 픽셀 퍼펙트 히트 테스트 함수
  const isPixelHit = (
    catTypeId: CatTypeId,
    clickX: number,
    clickY: number,
    catX: number,
    catY: number,
    size: number,
    direction: CatDirection,
    behaviorType: CatBehavior['type'],
    frame: number
  ): boolean => {
    // 클릭 위치가 고양이 영역 밖이면 false
    if (
      clickX < catX ||
      clickX > catX + size ||
      clickY < catY ||
      clickY > catY + size
    ) {
      return false;
    }
    
    // 스프라이트 이미지가 아직 로드되지 않았으면 기본 히트 테스트 (사각형)
    const catPixelData = spritePixelDataRef.current.get(catTypeId);
    if (!catPixelData || catPixelData.size === 0) {
      return true;
    }
    
    // 클릭 위치를 고양이 로컬 좌표로 변환
    const localX = clickX - catX;
    const localY = clickY - catY;
    
    // 원본 프레임 크기(32x32)로 스케일링
    const originalFrameSize = 32;
    const scale = size / originalFrameSize;
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
    const row = getCatSpriteRow(direction, behaviorType);
    const col = frame;
    const key = `${row}-${col}`;
    const pixelData = catPixelData.get(key);
    
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

  // 고양이 애니메이션 상수
  const CAT_CONFIG = {
    FRAME_DELAY: 150, // 프레임 전환 속도 (ms)
    MOVE_SPEED: 30, // 픽셀/초
    ENTER_DURATION: 150 * 4, // enter 단계 (4프레임)
    HOLD_DURATION: 3000, // hold 단계 (3초)
    EXIT_DURATION: 150 * 4, // exit 단계 (4프레임)
    LICKING_DURATION: 3000, // 핥기 지속 시간 (3초)
    MIN_ACTION_DURATION: 5000, // 앉기/눕기/핥기 최소 유지 시간 (1.5초) - 이 시간 전에는 마우스에 반응 안함
    INIT_DELAY: 1000, // 초기화 지연 (1초)
    IDLE_MIN: 2000, // 최소 대기 시간
    IDLE_MAX: 4000, // 최대 대기 시간
  };

  // 고양이 애니메이션 (여러 고양이 지원)
  useEffect(() => {
    if (enabledCats.length === 0) {
      catStatesRef.current.clear();
      setVisibleCats(new Set());
      return;
    }

    let animationFrameId: number;
    let lastTime = performance.now();
    let isRunning = true;

    // 컨테이너 경계 계산 헬퍼
    const getBounds = () => {
      const container = document.querySelector('.school-widget-container');
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const halfSize = catSize / 2;
      return {
        minX: 10 + halfSize,
        maxX: rect.width - 10 - halfSize,
        minY: 80 + halfSize,
        maxY: rect.height - 10 - halfSize,
      };
    };

    // 랜덤 목표 지점 생성
    const getRandomTarget = (): { x: number; y: number } | null => {
      const bounds = getBounds();
      if (!bounds) return null;
      return {
        x: Math.random() * (bounds.maxX - bounds.minX) + bounds.minX,
        y: Math.random() * (bounds.maxY - bounds.minY) + bounds.minY,
      };
    };

    // 랜덤 방향 선택
    const getRandomDirection = (): CatDirection => {
      const dirs: CatDirection[] = ['down', 'right', 'up', 'left'];
      return dirs[Math.floor(Math.random() * 4)];
    };

    // 랜덤 액션 선택 (앉기, 핥기, 눕기)
    const getRandomAction = (currentTime: number): CatBehavior => {
      const rand = Math.random();
      if (rand < 0.4) {
        return { type: 'sitting', phase: 'enter', phaseStartTime: currentTime, actionStartTime: currentTime };
      } else if (rand < 0.7) {
        return { type: 'licking', startTime: currentTime, duration: CAT_CONFIG.LICKING_DURATION };
      } else {
        return { type: 'lying', phase: 'enter', phaseStartTime: currentTime, actionStartTime: currentTime };
      }
    };

    // 고양이 초기화 (catId별로)
    const initCat = (catId: CatTypeId, index: number) => {
      if (catStatesRef.current.has(catId)) return;

      const bounds = getBounds();
      if (!bounds) return;

      // 각 고양이가 다른 위치에서 시작하도록 오프셋 적용
      const offsetX = (index % 3) * 50;
      const offsetY = Math.floor(index / 3) * 50;
      
      const centerX = Math.min(
        bounds.maxX,
        Math.max(bounds.minX, bounds.minX + offsetX + Math.random() * 100)
      );
      const centerY = Math.min(
        bounds.maxY,
        Math.max(bounds.minY, bounds.minY + offsetY + Math.random() * 100)
      );
      const halfSize = catSize / 2;

      catStatesRef.current.set(catId, {
        id: catId,
        x: centerX - halfSize,
        y: centerY - halfSize,
        direction: getRandomDirection(),
        behavior: { type: 'walking', target: getRandomTarget() },
        frame: 0,
      });
      
      setVisibleCats(prev => new Set([...prev, catId]));
    };

    // 프레임 계산 헬퍼
    const getFrameForPhase = (phase: CatActionPhase, phaseStartTime: number, currentTime: number): number => {
      const elapsed = currentTime - phaseStartTime;
      const frameIndex = Math.floor(elapsed / CAT_CONFIG.FRAME_DELAY);
      
      if (phase === 'enter') {
        return Math.min(frameIndex, 3);
      } else if (phase === 'hold') {
        return 3;
      } else {
        return Math.max(3 - frameIndex, 0);
      }
    };

    // 방향 결정 (히스테리시스 적용)
    const getDirectionToTarget = (dx: number, dy: number, currentDir: CatDirection): CatDirection => {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const isHorizontal = currentDir === 'left' || currentDir === 'right';
      
      if (isHorizontal) {
        if (absDy > absDx * 1.5) {
          return dy > 0 ? 'down' : 'up';
        }
        return dx > 0 ? 'right' : 'left';
      } else {
        if (absDx > absDy * 1.5) {
          return dx > 0 ? 'right' : 'left';
        }
        return dy > 0 ? 'down' : 'up';
      }
    };

    // 개별 고양이 애니메이션 업데이트
    const updateCat = (cat: CatState, currentTime: number, deltaSeconds: number) => {
      const bounds = getBounds();
      if (!bounds) return;

      const halfSize = catSize / 2;
      const catCenterX = cat.x + halfSize;
      const catCenterY = cat.y + halfSize;
      const moveDistance = CAT_CONFIG.MOVE_SPEED * deltaSeconds;

      // 마우스 위치 또는 랜덤 타겟
      const mousePos = targetPosRef.current;

      switch (cat.behavior.type) {
        case 'idle': {
          cat.behavior = { type: 'walking', target: getRandomTarget() };
          break;
        }

        case 'walking': {
          let targetX: number, targetY: number;
          const isRandomWandering = !mousePos;

          if (mousePos) {
            targetX = Math.max(bounds.minX, Math.min(bounds.maxX, mousePos.x));
            targetY = Math.max(bounds.minY, Math.min(bounds.maxY, mousePos.y));
            cat.behavior.target = null;
          } else if (cat.behavior.target) {
            targetX = cat.behavior.target.x;
            targetY = cat.behavior.target.y;
          } else {
            const newTarget = getRandomTarget();
            if (newTarget) {
              cat.behavior.target = newTarget;
              targetX = newTarget.x;
              targetY = newTarget.y;
            } else {
              targetX = catCenterX;
              targetY = catCenterY;
            }
          }

          const dx = targetX - catCenterX;
          const dy = targetY - catCenterY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const arrivalThreshold = isRandomWandering ? 5 : 2;

          if (distance <= arrivalThreshold) {
            if (isRandomWandering) {
              cat.behavior = getRandomAction(currentTime);
            } else {
              cat.behavior = { type: 'sitting', phase: 'hold', phaseStartTime: currentTime, actionStartTime: currentTime };
              cat.frame = 3;
            }
          } else {
            const moveX = (dx / distance) * moveDistance;
            const moveY = (dy / distance) * moveDistance;
            
            const newCenterX = Math.max(bounds.minX, Math.min(bounds.maxX, catCenterX + moveX));
            const newCenterY = Math.max(bounds.minY, Math.min(bounds.maxY, catCenterY + moveY));
            
            cat.x = newCenterX - halfSize;
            cat.y = newCenterY - halfSize;
            cat.direction = getDirectionToTarget(dx, dy, cat.direction);
            cat.frame = Math.floor(currentTime / CAT_CONFIG.FRAME_DELAY) % 4;
          }
          break;
        }

        case 'sitting':
        case 'lying': {
          const behavior = cat.behavior as CatBehaviorSitting | CatBehaviorLying;
          const elapsed = currentTime - behavior.phaseStartTime;
          const totalActionTime = currentTime - behavior.actionStartTime;
          
          // 최소 유지 시간이 지난 후에만 마우스에 반응
          if (mousePos && totalActionTime >= CAT_CONFIG.MIN_ACTION_DURATION) {
            const dx = mousePos.x - catCenterX;
            const dy = mousePos.y - catCenterY;
            if (Math.sqrt(dx * dx + dy * dy) > 10) {
              cat.behavior = { type: 'walking', target: null };
              break;
            }
          }

          if (behavior.phase === 'enter' && elapsed >= CAT_CONFIG.ENTER_DURATION) {
            cat.behavior = { ...behavior, phase: 'hold', phaseStartTime: currentTime };
          } else if (behavior.phase === 'hold' && elapsed >= CAT_CONFIG.HOLD_DURATION) {
            cat.behavior = { ...behavior, phase: 'exit', phaseStartTime: currentTime };
          } else if (behavior.phase === 'exit' && elapsed >= CAT_CONFIG.EXIT_DURATION) {
            cat.behavior = { type: 'walking', target: getRandomTarget() };
            cat.direction = getRandomDirection();
          }

          cat.frame = getFrameForPhase(behavior.phase, behavior.phaseStartTime, currentTime);
          break;
        }

        case 'licking': {
          const elapsed = currentTime - cat.behavior.startTime;

          // 최소 유지 시간이 지난 후에만 마우스에 반응
          if (mousePos && elapsed >= CAT_CONFIG.MIN_ACTION_DURATION) {
            const dx = mousePos.x - catCenterX;
            const dy = mousePos.y - catCenterY;
            if (Math.sqrt(dx * dx + dy * dy) > 10) {
              cat.behavior = { type: 'walking', target: null };
              break;
            }
          }

          if (elapsed >= cat.behavior.duration) {
            cat.behavior = { type: 'walking', target: getRandomTarget() };
            cat.direction = getRandomDirection();
          } else {
            cat.frame = Math.floor(currentTime / CAT_CONFIG.FRAME_DELAY) % 4;
          }
          break;
        }
      }
    };

    // 메인 애니메이션 루프
    const animate = (currentTime: number) => {
      if (!isRunning) return;

      const deltaTime = currentTime - lastTime;
      lastTime = currentTime;
      const deltaSeconds = deltaTime / 1000;

      // 모든 활성 고양이 업데이트
      catStatesRef.current.forEach((cat) => {
        updateCat(cat, currentTime, deltaSeconds);

        // DOM 직접 업데이트
        const el = catElementsRef.current.get(cat.id);
        if (el) {
          el.style.left = `${cat.x}px`;
          el.style.top = `${cat.y}px`;
          
          const row = getCatSpriteRow(cat.direction, cat.behavior.type);
          el.style.backgroundPosition = `-${cat.frame * catSize}px -${row * catSize}px`;
        }
      });

      animationFrameId = requestAnimationFrame(animate);
    };

    // 활성화된 고양이들 초기화 (지연 시간 적용)
    const initTimeouts = enabledCats.map((catId, index) => 
      setTimeout(() => initCat(catId, index), CAT_CONFIG.INIT_DELAY + index * 500)
    );
    
    animationFrameId = requestAnimationFrame(animate);

    return () => {
      isRunning = false;
      initTimeouts.forEach(clearTimeout);
      cancelAnimationFrame(animationFrameId);
    };
  }, [enabledCats, catSize]);

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
                <label style={{ marginBottom: '8px', display: 'block', fontWeight: 500 }}>
                  고양이 선택
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
                  {CAT_TYPES.map(catType => (
                    <label
                      key={catType.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 12px',
                        backgroundColor: enabledCats.includes(catType.id) ? 'rgba(100, 200, 100, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        border: enabledCats.includes(catType.id) ? '1px solid rgba(100, 200, 100, 0.5)' : '1px solid rgba(255, 255, 255, 0.2)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={enabledCats.includes(catType.id)}
                        onChange={(e) => {
                          let newEnabledCats: CatTypeId[];
                          if (e.target.checked) {
                            newEnabledCats = [...enabledCats, catType.id];
                          } else {
                            newEnabledCats = enabledCats.filter(id => id !== catType.id);
                            // 비활성화된 고양이 상태 제거
                            catStatesRef.current.delete(catType.id);
                            setVisibleCats(prev => {
                              const next = new Set(prev);
                              next.delete(catType.id);
                              return next;
                            });
                          }
                          setEnabledCats(newEnabledCats);
                          localStorage.setItem('schoolEnabledCats', JSON.stringify(newEnabledCats));
                        }}
                        style={{ display: 'none' }}
                      />
                      <span
                        style={{
                          width: '16px',
                          height: '16px',
                          backgroundImage: `url(${new URL(`./asset/${catType.sprite}`, import.meta.url).href})`,
                          backgroundSize: `64px ${16 * catType.rows}px`,
                          backgroundPosition: '-32px 0',
                          imageRendering: 'pixelated',
                        }}
                      />
                      <span style={{ fontSize: '13px' }}>{catType.name}</span>
                    </label>
                  ))}
                </div>
                <div className="setting-description">
                  여러 고양이를 선택하면 함께 돌아다닙니다.
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

      {/* 고양이 스프라이트들 - tab-content 바깥에서 모든 탭에 표시 */}
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
              
              const isHit = isPixelHit(
                catId,
                clickX,
                clickY,
                cat.x,
                cat.y,
                catSize,
                cat.direction,
                cat.behavior.type,
                cat.frame
              );
              
              if (!isHit) return;
              
              // 클릭 시 1픽셀씩 커지기
              const newSize = catSize + 1;
              setCatSize(newSize);
              localStorage.setItem('schoolCatSize', newSize.toString());
              
              // 클릭 시 앉거나 눕기 (50% 확률)
              const currentTime = performance.now();
              if (Math.random() < 0.5) {
                cat.behavior = { type: 'sitting', phase: 'enter', phaseStartTime: currentTime, actionStartTime: currentTime };
              } else {
                cat.behavior = { type: 'lying', phase: 'enter', phaseStartTime: currentTime, actionStartTime: currentTime };
              }
              cat.frame = 0;
            }}
            style={{
              position: 'absolute',
              left: '0px',
              top: '0px',
              width: `${catSize}px`,
              height: `${catSize}px`,
              backgroundImage: `url(${new URL(`./asset/${catType.sprite}`, import.meta.url).href})`,
              backgroundSize: `${catSize * 4}px ${catSize * catType.rows}px`,
              backgroundPosition: '0px 0px',
              imageRendering: 'pixelated',
              zIndex: 1000,
              cursor: 'pointer',
              pointerEvents: 'auto',
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

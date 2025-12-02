import type { Message, PeriodSchedule } from '../types';

/**
 * 메시지에서 일정 정보를 추출합니다.
 * 메시지에 schedule 필드가 있거나, content에서 일정 정보를 파싱합니다.
 */
export function extractSchedulesFromMessages(messages: Message[]): PeriodSchedule[] {
  const schedules: PeriodSchedule[] = [];

  console.log('Extracting schedules from messages:', messages.length);

  messages.forEach((message, index) => {
    const messageData = message as any;
    
    // deadline 필드가 있는 메시지에서 일정 추출
    const deadline = messageData.deadline || messageData._rawData?.deadline;
    const calendarTitle = messageData.calendarTitle || messageData._rawData?.calendarTitle;
    
    if (deadline) {
      try {
        // deadline을 Date로 파싱
        const deadlineDate = new Date(deadline);
        
        if (!isNaN(deadlineDate.getTime())) {
          // 날짜만 추출 (시간 제거)
          const dateStr = deadlineDate.toISOString().split('T')[0];
          
          // startDate와 endDate를 같은 날짜로 설정 (하루 종일 이벤트)
          schedules.push({
            id: `message-${message.id}`,
            content: message.content, // 원본 메시지 전체 내용 사용
            startDate: dateStr,
            endDate: dateStr,
            calendarTitle: calendarTitle || message.content.substring(0, 30),
            createdAt: message.receive_date || new Date().toISOString(),
            updatedAt: message.receive_date || new Date().toISOString(),
          });
          
          console.log(`Extracted schedule from message ${message.id}:`, {
            deadline,
            calendarTitle,
            dateStr
          });
        }
      } catch (error) {
        console.warn(`Failed to parse deadline for message ${message.id}:`, error);
      }
    }
    
    // 디버깅: 처음 몇 개 메시지 구조 확인
    if (index < 3) {
      console.log(`Message ${index}:`, {
        id: message.id,
        sender: message.sender,
        hasDeadline: !!deadline,
        deadline,
        calendarTitle,
        hasRawData: !!messageData._rawData,
        keys: Object.keys(messageData),
        rawKeys: messageData._rawData ? Object.keys(messageData._rawData) : []
      });
    }
    
    // 기존 schedule 필드도 지원 (하위 호환성)
    if (messageData.schedule) {
      const schedule = messageData.schedule;
      console.log('Found schedule in message:', schedule);
      if (schedule.startDate && schedule.endDate) {
        schedules.push({
          id: `message-${message.id}-schedule`,
          content: schedule.content || message.content, // 원본 메시지 전체 내용 사용
          startDate: schedule.startDate,
          endDate: schedule.endDate,
          calendarTitle: schedule.calendarTitle || schedule.content || message.content.substring(0, 30),
          createdAt: message.receive_date || new Date().toISOString(),
          updatedAt: message.receive_date || new Date().toISOString(),
        });
      }
    }

    // _rawData에서 schedule 찾기
    if (messageData._rawData?.schedule) {
      const schedule = messageData._rawData.schedule;
      console.log('Found schedule in _rawData:', schedule);
      if (schedule.startDate && schedule.endDate) {
        schedules.push({
          id: `message-${message.id}-raw-schedule`,
          content: schedule.content || message.content, // 원본 메시지 전체 내용 사용
          startDate: schedule.startDate,
          endDate: schedule.endDate,
          calendarTitle: schedule.calendarTitle || schedule.content || message.content.substring(0, 30),
          createdAt: message.receive_date || new Date().toISOString(),
          updatedAt: message.receive_date || new Date().toISOString(),
        });
      }
    }

    // content HTML에서 일정 정보를 파싱하는 경우
    if (message.content) {
      try {
        // HTML에서 data-schedule 속성이나 특정 패턴을 찾기
        const parser = new DOMParser();
        const doc = parser.parseFromString(message.content, 'text/html');
        
        // data-schedule 속성이 있는 요소 찾기
        const scheduleElements = doc.querySelectorAll('[data-schedule]');
        scheduleElements.forEach((elem) => {
          const scheduleData = elem.getAttribute('data-schedule');
          if (scheduleData) {
            try {
              const schedule = JSON.parse(scheduleData);
              if (schedule.startDate && schedule.endDate) {
                schedules.push({
                  id: `message-${message.id}-${schedules.length}`,
                  content: schedule.content || message.content, // 원본 메시지 전체 내용 사용
                  startDate: schedule.startDate,
                  endDate: schedule.endDate,
                  calendarTitle: schedule.calendarTitle || schedule.content || elem.textContent?.substring(0, 30) || message.content.substring(0, 30),
                  createdAt: message.receive_date || new Date().toISOString(),
                  updatedAt: message.receive_date || new Date().toISOString(),
                });
              }
            } catch (e) {
              // JSON 파싱 실패 시 무시
            }
          }
        });

        // 메타 태그에서 일정 정보 찾기
        const metaSchedule = doc.querySelector('meta[name="schedule"]');
        if (metaSchedule) {
          const scheduleContent = metaSchedule.getAttribute('content');
          if (scheduleContent) {
            try {
              const schedule = JSON.parse(scheduleContent);
              if (schedule.startDate && schedule.endDate) {
                schedules.push({
                  id: `message-${message.id}-meta`,
                  content: schedule.content || message.content, // 원본 메시지 전체 내용 사용
                  startDate: schedule.startDate,
                  endDate: schedule.endDate,
                  calendarTitle: schedule.calendarTitle || schedule.content || message.content.substring(0, 30),
                  createdAt: message.receive_date || new Date().toISOString(),
                  updatedAt: message.receive_date || new Date().toISOString(),
                });
              }
            } catch (e) {
              // JSON 파싱 실패 시 무시
            }
          }
        }
      } catch (error) {
        // HTML 파싱 실패 시 무시
        console.warn('Failed to parse message content for schedule:', error);
      }
    }
  });

  return schedules;
}


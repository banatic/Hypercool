import { describe, it, expect } from 'vitest';
import { extractSchedulesFromMessages } from './messageScheduleExtractor';

describe('extractSchedulesFromMessages', () => {
    it('should extract schedule from deadline field', () => {
        const messages = [{
            id: 1,
            content: 'Test Message',
            sender: 'User',
            receive_date: '2023-01-01T00:00:00Z',
            deadline: '2023-12-25'
        }];

        const schedules = extractSchedulesFromMessages(messages as any);
        expect(schedules).toHaveLength(1);
        expect(schedules[0].startDate).toBe('2023-12-25');
        expect(schedules[0].endDate).toBe('2023-12-25');
    });

    it('should extract schedule from _rawData.deadline', () => {
        const messages = [{
            id: 2,
            content: 'Test Message',
            sender: 'User',
            receive_date: '2023-01-01T00:00:00Z',
            _rawData: {
                deadline: '2023-12-25'
            }
        }];

        const schedules = extractSchedulesFromMessages(messages as any);
        expect(schedules).toHaveLength(1);
        expect(schedules[0].startDate).toBe('2023-12-25');
    });

    it('should extract schedule from content HTML data-schedule', () => {
        const scheduleData = JSON.stringify({
            startDate: '2023-12-25',
            endDate: '2023-12-26',
            content: 'Christmas'
        });
        // Escape quotes for HTML attribute
        const escapedData = scheduleData.replace(/"/g, '&quot;');

        const messages = [{
            id: 3,
            content: `<div data-schedule="${escapedData}">Christmas Event</div>`,
            sender: 'User',
            receive_date: '2023-01-01T00:00:00Z'
        }];

        const schedules = extractSchedulesFromMessages(messages as any);
        expect(schedules).toHaveLength(1);
        expect(schedules[0].startDate).toBe('2023-12-25');
        expect(schedules[0].endDate).toBe('2023-12-26');
        expect(schedules[0].content).toBe('Christmas');
    });
});

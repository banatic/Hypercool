import { invoke } from '@tauri-apps/api/core';
import { Message } from '../types';

/** 본문만 제한된 LRU에 보관. 목록을 오래 탐색해도 전체 본문이 누적되지 않는다. */
export class MessageContentStore {
    private cache = new Map<number, Message>();
    private pending = new Map<number, Promise<Message>>();
    private bytes = 0;

    constructor(private dbPath: string, private maxEntries = 30, private maxBytes = 8 * 1024 * 1024) {}

    get(id: number): Promise<Message> {
        const cached = this.cache.get(id);
        if (cached) {
            this.cache.delete(id);
            this.cache.set(id, cached);
            return Promise.resolve(cached);
        }
        const existing = this.pending.get(id);
        if (existing) return existing;
        const request = invoke<Message>('get_message_by_id', { dbPath: this.dbPath, id })
            .then(message => {
                const size = message.content.length * 2;
                if (size <= this.maxBytes) {
                    while (this.cache.size >= this.maxEntries || this.bytes + size > this.maxBytes) {
                        const oldest = this.cache.keys().next().value as number;
                        this.bytes -= this.cache.get(oldest)!.content.length * 2;
                        this.cache.delete(oldest);
                    }
                    this.cache.set(id, message);
                    this.bytes += size;
                }
                return message;
            })
            .finally(() => this.pending.delete(id));
        this.pending.set(id, request);
        return request;
    }
}

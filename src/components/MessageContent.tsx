import { memo, useEffect, useMemo, useState } from 'react';
import { Message, MessageMeta } from '../types';
import { decodeEntities } from '../utils/dateUtils';

interface Props {
    message: MessageMeta;
    className: string;
    getFullMessage: (id: number) => Promise<Message | null>;
}

/** 마운트된 카드만 전체 HTML을 읽고 디코드한다. 미리보기는 일반 텍스트다. */
export const MessageContent = memo(({ message, className, getFullMessage }: Props) => {
    const [loaded, setLoaded] = useState<{ id: number; content: string } | null>(null);
    useEffect(() => {
        let cancelled = false;
        setLoaded(null);
        void getFullMessage(message.id).then(full => {
            if (!cancelled && full) setLoaded({ id: full.id, content: full.content });
        });
        return () => { cancelled = true; };
    }, [message.id, getFullMessage]);
    const html = useMemo(() => loaded?.id === message.id ? decodeEntities(loaded.content) : null, [loaded, message.id]);
    return html === null
        ? <div className={className}>{message.preview}</div>
        : <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});

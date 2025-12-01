import React from 'react';
import type { Message } from '../types';
import './MessageList.css';

interface MessageListProps {
  messages: Message[];
  loading: boolean;
}

export const MessageList: React.FC<MessageListProps> = ({ messages, loading }) => {
  if (loading) {
    return <div className="loading-state">Loading messages...</div>;
  }

  if (messages.length === 0) {
    return <p className="empty-state">No messages found.</p>;
  }

  return (
    <ul className="message-list">
      {messages.map(message => (
        <li key={message.id} className="message-item">
          <div className="message-header">
            <span className="message-sender">{message.sender}</span>
            {message.receive_date && <span className="message-date">{message.receive_date}</span>}
          </div>
          <p className="message-content">{message.content}</p>
        </li>
      ))}
    </ul>
  );
};

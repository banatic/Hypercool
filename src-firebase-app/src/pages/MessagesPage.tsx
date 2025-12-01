import React from 'react';
import { Card } from '../components/ui/Card';
import { useMessages } from '../hooks/useMessages';
import { MessageList } from '../components/MessageList';

export const MessagesPage: React.FC = () => {
  const { messages, loading } = useMessages();

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Messages</h1>
        <p>View your received messages.</p>
      </div>
      
      <Card>
        <MessageList messages={messages} loading={loading} />
      </Card>
    </div>
  );
};

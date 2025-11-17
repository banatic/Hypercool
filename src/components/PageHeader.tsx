import React from 'react';

export const PageHeader = ({ title, children }: { title: React.ReactNode, children?: React.ReactNode }) => (
  <div className="page-header">
    <h2 className="page-title">{title}</h2>
    <div className="page-header-actions">{children}</div>
  </div>
);

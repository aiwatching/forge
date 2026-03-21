'use client';

import React from 'react';

export interface Tab {
  id: number;
  label: string;
}

export interface TabBarProps {
  tabs: Tab[];
  activeId: number;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
}

export default function TabBar({ tabs, activeId, onActivate, onClose }: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center border-b border-[var(--border)] bg-[var(--bg-tertiary)] overflow-x-auto shrink-0">
      {tabs.map(tab => (
        <div
          key={tab.id}
          className={`flex items-center gap-1 px-3 py-1.5 text-[11px] cursor-pointer border-r border-[var(--border)]/30 shrink-0 group ${
            tab.id === activeId
              ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] border-b-2 border-b-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
          }`}
          onClick={() => onActivate(tab.id)}
        >
          <span className="truncate max-w-[120px]">{tab.label}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            className="text-[9px] w-4 h-4 flex items-center justify-center rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] opacity-0 group-hover:opacity-100 shrink-0"
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}

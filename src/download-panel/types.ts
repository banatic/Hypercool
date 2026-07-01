export interface FileInfo {
  name: string;
  path: string;
  size: number | null;
  modified: string | null;
  exists: boolean;
}

export type PanelStatus = 'searching' | 'connected' | 'disconnected';

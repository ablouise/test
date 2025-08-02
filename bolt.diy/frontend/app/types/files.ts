export interface FileEvent {
  type: 'create' | 'modify' | 'delete';
  path: string;
  content?: string; // For file content changes
  isBinary?: boolean; // To indicate if the file is binary
}

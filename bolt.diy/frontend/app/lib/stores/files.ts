import { map, type MapStore } from 'nanostores';
import { dockerClient, type DockerClient, type FileEvent } from '~/lib/dockerclient';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('FilesStore');

interface ImportMeta {
  hot?: {
    data?: {
      modifiedFiles?: Map<string, string>;
      deletedPaths?: Set<string>;
      files?: MapStore<FileMap>;
      [key: string]: any;
    };
    accept?: () => void;
    dispose?: (callback: () => void) => void;
  };
}

interface File {
  type: 'file';
  content: string;
  isBinary: boolean;
  isLocked?: boolean;
  lockedByFolder?: string;
}

interface Folder {
  type: 'folder';
  isLocked?: boolean;
  lockedByFolder?: string;
}

type Dirent = File | Folder;
export type FileMap = Record<string, Dirent | undefined>;

function isBinaryFile(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  // Check for null bytes (common in binary files)
  for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }

  // Check for high ratio of non-printable characters
  let nonPrintableCount = 0;
  const sampleSize = Math.min(buffer.length, 1000);

  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];

    // Non-printable ASCII characters (except common whitespace)
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintableCount++;
    }
  }

  // If more than 30% non-printable characters, consider it binary
  return nonPrintableCount / sampleSize > 0.3;
}

export class FilesStore {
  #dockerClient: DockerClient | null = null;
  #size = 0;
  #fileWatcher: { close: () => void } | null = null;
  #pendingWrites: Map<string, Promise<void>> = new Map();
  #activeLocks: Map<string, boolean> = new Map();
  #initialScanComplete = false;
  #reconnectAttempts = 0;
  #maxReconnectAttempts = 5;
  #reconnectDelay = 2000;
  #shuttingDown = false;
  #eventQueue: FileEvent[] = [];
  #processingQueue = false;
  #modifiedFiles: Map<string, string> = new Map();
  #deletedPaths: Set<string> = new Set();
  #initialized = false;
  files: MapStore<FileMap> = map({});

  get filesCount() {
    return this.#size;
  }

  get isInitialized(): boolean {
    return typeof window !== 'undefined' && !!this.#dockerClient && this.#initialized;
  }

  constructor() {
    // COMPLETELY skip all Docker operations on server-side
    if (typeof window === 'undefined') {
      logger.info('FilesStore: Running on server - skipping Docker initialization');
      return;
    }

    // Only initialize on client with available dockerClient
    if (dockerClient) {
      this.#dockerClient = dockerClient;
      this.#initialize();
    } else {
      logger.warn('FilesStore: DockerClient not available - using fallback mode');
    }
  }

  // Add this method to your FilesStore class
  resetFileModifications(): void {
    if (typeof window === 'undefined') {
      console.warn('FilesStore: resetFileModifications called on server-side');
      return;
    }

    this.#modifiedFiles.clear();
    this.#deletedPaths.clear();

    // Reset the files map to initial state
    this.files.set({});
    this.#size = 0;

    console.log('FilesStore: File modifications reset');
  }

  #initialize() {
    if (this.#initialized || !this.#dockerClient) {
      return;
    }

    this.#initialized = true;
    logger.info('FilesStore: Initializing on client-side');

    // Fix: Add proper type guards for import.meta
    const importMeta = import.meta as ImportMeta;
    const hotData = importMeta?.hot?.data;

    this.#modifiedFiles = hotData?.modifiedFiles || new Map();
    this.#deletedPaths = hotData?.deletedPaths || new Set();
    this.files = hotData?.files || map({});

    this.#loadPersistedState();
    this.#init().catch((error) => {
      logger.error('FilesStore initialization failed:', error);
      this.#attemptReconnect();
    });
  }

  async #init() {
    if (!this.isInitialized) {
      return;
    }

    try {
      await this.#initContainer();
      await this.#setupFileWatcher();
      await this.#initialFileScan();

      this.#cleanupDeletedFiles();
      this.#startEventQueueProcessor();
      this.#initialScanComplete = true;
      logger.info('FilesStore initialized successfully');
    } catch (error) {
      logger.error('FilesStore initialization error:', error);

      if (!this.#shuttingDown) {
        this.#attemptReconnect();
      }
    }
  }

  async #initContainer() {
    if (!this.#dockerClient) {
      throw new Error('Docker client not available');
    }

    try {
      logger.info('Ensuring container is ready...');
      await this.#dockerClient.ensureContainerReady('default-project');
      logger.info(`Container ready: ${this.#dockerClient.currentContainerId}`);
    } catch (error) {
      logger.error('Container initialization failed:', error);
      throw error;
    }
  }

  async #setupFileWatcher() {
    if (!this.#dockerClient || !this.isInitialized) {
      return;
    }

    try {
      const watchOptions = {
        include: ['**/*'],
        exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        includeContent: true,
        pollInterval: 5000,
      };

      this.#fileWatcher = await this.#dockerClient.watchPaths(watchOptions, (events: FileEvent[]) => {
        this.#handleFileEvents(events);
      });

      logger.info('File watcher initialized with /app paths');
    } catch (error) {
      logger.error('Failed to setup file watcher:', error);
      throw error;
    }
  }

  #handleFileEvents(events: FileEvent[]) {
    if (!this.isInitialized) {
      return;
    }

    this.#eventQueue.push(...events);
    this.#processEventQueue();
  }

  #processEventQueue() {
    if (this.#processingQueue || this.#eventQueue.length === 0) {
      return;
    }

    this.#processingQueue = true;

    try {
      const events = [...this.#eventQueue];
      this.#eventQueue = [];

      for (const event of events) {
        this.#processFileEvent(event);
      }
    } catch (error) {
      logger.error('Error processing file events:', error);
    } finally {
      this.#processingQueue = false;
    }
  }

  #processFileEvent(event: FileEvent) {
    const filePath = event.path.replace('/app/', '/workdir/');

    switch (event.type) {
      case 'create':
      case 'modify':
        if (event.content) {
          const buffer = Buffer.from(event.content);
          this.files.setKey(filePath, {
            type: 'file',
            content: event.content,
            isBinary: isBinaryFile(buffer),
          });
          this.#size++;
        }

        break;
      case 'delete':
        this.files.setKey(filePath, undefined);
        this.#deletedPaths.add(filePath);
        this.#size = Math.max(0, this.#size - 1);
        break;
    }
  }

  async #initialFileScan() {
    if (!this.#dockerClient || !this.isInitialized) {
      return;
    }

    logger.info('Starting initial file scan...');

    try {
      const entries = await this.#dockerClient.readDir('/app');
      await this.#processDirectoryEntries('/app', entries);
      logger.info('Initial file scan completed');
    } catch (error) {
      logger.error('Initial file scan failed:', error);
    }
  }

  async #processDirectoryEntries(dirPath: string, entries: Array<{ name: string; type: 'file' | 'directory' }>) {
    if (!this.#dockerClient || !this.isInitialized) {
      return;
    }

    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;
      const normalizedPath = fullPath.replace('/app/', '/workdir/');

      if (entry.type === 'directory') {
        this.files.setKey(normalizedPath, { type: 'folder' });

        try {
          const subEntries = await this.#dockerClient.readDir(fullPath);
          await this.#processDirectoryEntries(fullPath, subEntries);
        } catch (error) {
          logger.warn(`Failed to read directory ${fullPath}:`, error);
        }
      } else {
        try {
          const content = await this.#dockerClient.readFile(fullPath);
          const buffer = Buffer.from(content);
          this.files.setKey(normalizedPath, {
            type: 'file',
            content,
            isBinary: isBinaryFile(buffer),
          });
          this.#size++;
        } catch (error) {
          logger.warn(`Failed to read file ${fullPath}:`, error);
        }
      }
    }
  }

  #startEventQueueProcessor() {
    const processQueue = () => {
      if (!this.#shuttingDown) {
        this.#processEventQueue();
        setTimeout(processQueue, 1000);
      }
    };
    processQueue();
  }

  #cleanupDeletedFiles() {
    for (const deletedPath of this.#deletedPaths) {
      this.files.setKey(deletedPath, undefined);
    }
    this.#deletedPaths.clear();
  }

  #loadPersistedState() {
    try {
      if (typeof localStorage !== 'undefined') {
        const deletedPaths = localStorage.getItem('bolt-deleted-paths');

        if (deletedPaths) {
          JSON.parse(deletedPaths).forEach((p: string) => this.#deletedPaths.add(p));
        }
      }
    } catch (error) {
      logger.warn('Failed to load persisted state:', error);
    }
  }

  async saveFile(filePath: string, content: string | Uint8Array): Promise<void> {
    if (typeof window === 'undefined' || !this.#dockerClient) {
      logger.warn('FilesStore: Docker operations not available on server-side');
      return;
    }

    if (this.#pendingWrites.has(filePath)) {
      await this.#pendingWrites.get(filePath);
    }

    const writePromise = this.#performSaveFile(filePath, content);
    this.#pendingWrites.set(filePath, writePromise);

    try {
      await writePromise;
    } finally {
      this.#pendingWrites.delete(filePath);
    }
  }

  async #performSaveFile(filePath: string, content: string | Uint8Array): Promise<void> {
    if (!this.#dockerClient) {
      return;
    }

    const dockerPath = filePath.replace('/workdir', '/app');

    try {
      await this.#dockerClient.writeFile(dockerPath, content);

      const contentStr = content instanceof Uint8Array ? Buffer.from(content).toString() : content;
      const buffer = Buffer.from(contentStr);

      this.files.setKey(filePath, {
        type: 'file',
        content: contentStr,
        isBinary: isBinaryFile(buffer),
      });

      this.#modifiedFiles.set(filePath, contentStr);
      logger.debug(`File saved: ${filePath}`);
    } catch (error) {
      logger.error(`Failed to save file ${filePath}:`, error);
      throw error;
    }
  }

  async readFile(filePath: string): Promise<string> {
    if (!this.isInitialized || !this.#dockerClient) {
      throw new Error('FilesStore not initialized - running on server?');
    }

    const dockerPath = filePath.replace('/workdir', '/app');

    try {
      const content = await this.#dockerClient.readFile(dockerPath);

      const buffer = Buffer.from(content);
      this.files.setKey(filePath, {
        type: 'file',
        content,
        isBinary: isBinaryFile(buffer),
      });

      return content;
    } catch (error) {
      logger.error(`Failed to read file ${filePath}:`, error);
      throw error;
    }
  }

  async createFolder(folderPath: string): Promise<void> {
    if (!this.isInitialized || !this.#dockerClient) {
      logger.warn('FilesStore: createFolder called but not initialized');
      return;
    }

    const dockerPath = folderPath.replace('/workdir', '/app');

    try {
      await this.#dockerClient.mkdir(dockerPath, { recursive: true });

      this.files.setKey(folderPath, { type: 'folder' });
      logger.debug(`Folder created: ${folderPath}`);
    } catch (error) {
      logger.error(`Failed to create folder ${folderPath}:`, error);
      throw error;
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    if (!this.isInitialized || !this.#dockerClient) {
      logger.warn('FilesStore: deleteFile called but not initialized');
      return;
    }

    const dockerPath = filePath.replace('/workdir', '/app');

    try {
      await this.#dockerClient.rm(dockerPath, { force: true });

      this.files.setKey(filePath, undefined);
      this.#deletedPaths.add(filePath);
      this.#size = Math.max(0, this.#size - 1);

      logger.debug(`File deleted: ${filePath}`);
    } catch (error) {
      logger.error(`Failed to delete file ${filePath}:`, error);
      throw error;
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    if (!this.isInitialized || !this.#dockerClient) {
      logger.warn('FilesStore: renameFile called but not initialized');
      return;
    }

    const oldDockerPath = oldPath.replace('/workdir', '/app');
    const newDockerPath = newPath.replace('/workdir', '/app');

    try {
      await this.#dockerClient.mv(oldDockerPath, newDockerPath);

      const file = this.files.get()[oldPath];

      if (file) {
        this.files.setKey(newPath, file);
        this.files.setKey(oldPath, undefined);
      }

      logger.debug(`File renamed: ${oldPath} -> ${newPath}`);
    } catch (error) {
      logger.error(`Failed to rename file ${oldPath} to ${newPath}:`, error);
      throw error;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    if (!this.isInitialized || !this.#dockerClient) {
      return false;
    }

    const dockerPath = filePath.replace('/workdir', '/app');

    try {
      return await this.#dockerClient.exists(dockerPath);
    } catch (error) {
      logger.error(`Failed to check if file exists ${filePath}:`, error);
      return false;
    }
  }

  #attemptReconnect() {
    if (this.#shuttingDown || this.#reconnectAttempts >= this.#maxReconnectAttempts) {
      return;
    }

    this.#reconnectAttempts++;
    logger.info(`FilesStore: Attempting to reconnect (${this.#reconnectAttempts}/${this.#maxReconnectAttempts})`);

    setTimeout(() => {
      this.#init().catch((error) => {
        logger.error('Reconnection failed:', error);
        this.#attemptReconnect();
      });
    }, this.#reconnectDelay * this.#reconnectAttempts);
  }

  async shutdown() {
    this.#shuttingDown = true;

    if (this.#fileWatcher) {
      this.#fileWatcher.close();
      this.#fileWatcher = null;
    }

    const pendingWrites = Array.from(this.#pendingWrites.values());

    if (pendingWrites.length > 0) {
      logger.info('Waiting for pending writes to complete...');
      await Promise.allSettled(pendingWrites);
    }

    logger.info('FilesStore shutdown complete');
  }

  dispose() {
    const importMeta = import.meta as ImportMeta;

    if (importMeta?.hot?.dispose) {
      importMeta.hot.dispose(() => {
        this.shutdown();
      });
    }
  }
}

import { getEncoding } from 'istextorbinary';
import { map, type MapStore } from 'nanostores';
import { Buffer } from 'node:buffer';
import { path } from '~/utils/path';
import { WORK_DIR } from '~/utils/constants';
import { computeFileModifications } from '~/utils/diff';
import { createScopedLogger } from '~/utils/logger';
import {
  addLockedFile,
  removeLockedFile,
  addLockedFolder,
  removeLockedFolder,
  getLockedItemsForChat,
  getLockedFilesForChat,
  getLockedFoldersForChat,
  isPathInLockedFolder,
  migrateLegacyLocks,
} from '~/lib/persistence/lockedFiles';
import { getCurrentChatId } from '~/utils/fileLocks';
import { DockerClient } from '~/lib/dockerclient/docker-client';

const logger = createScopedLogger('FilesStore');

// First, ensure you have proper type definitions for ImportMeta
interface ImportMeta {
  hot?: {
    data: any;
    accept: () => void;
    dispose: (callback: () => void) => void;
  };
}

// 1. First, define strict interfaces for all types
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
type FileMap = Record<string, Dirent | undefined>;

export type DockerFileEvent = {
  type: 'create' | 'modify' | 'delete' | 'rename';
  path: string;
  newPath?: string;
  content?: string;
  isDirectory?: boolean;
  timestamp?: number;
};

// More robust type guards
function isFile(dirent: unknown): dirent is File {
  return (
    typeof dirent === 'object' &&
    dirent !== null &&
    'type' in dirent &&
    dirent.type === 'file' &&
    'content' in dirent &&
    'isBinary' in dirent
  );
}

function isFolder(dirent: unknown): dirent is Folder {
  return typeof dirent === 'object' && dirent !== null && 'type' in dirent && dirent.type === 'folder';
}

// Add these type guards at the top of your file
function isFileObject(obj: unknown): obj is File {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    obj.type === 'file' &&
    'content' in obj &&
    'isBinary' in obj
  );
}

function isFolderObject(obj: unknown): obj is Folder {
  return typeof obj === 'object' && obj !== null && 'type' in obj && obj.type === 'folder';
}

export class FilesStore {
  #dockerClient: DockerClient;
  #size = 0;
  #fileWatcher: { close: () => void } | null = null;
  #pendingWrites: Map<string, Promise<void>> = new Map();
  #activeLocks: Map<string, boolean> = new Map();
  #initialScanComplete = false;
  #reconnectAttempts = 0;
  #maxReconnectAttempts = 5;
  #reconnectDelay = 2000;
  #shuttingDown = false;
  #eventQueue: DockerFileEvent[] = [];
  #processingQueue = false;
  #modifiedFiles: Map<string, string>;
  #deletedPaths: Set<string>;
  files: MapStore<FileMap> = map({});

  get filesCount() {
    return this.#size;
  }

  constructor(dockerClient: DockerClient) {
    this.#dockerClient = dockerClient;

    // Initialize with proper type checking
    this.#modifiedFiles = (import.meta as ImportMeta).hot?.data?.modifiedFiles || new Map();
    this.#deletedPaths = (import.meta as ImportMeta).hot?.data?.deletedPaths || new Set();
    this.files = (import.meta as ImportMeta).hot?.data?.files || map({});

    this.#loadPersistedState();
    this.#init().catch((error) => {
      logger.error('Initialization error:', error);
    });
  }

  async #init() {
    try {
      // 1. Initialize container first
      await this.#initContainer();

      // 2. Setup file watcher only after container is ready
      await this.#setupFileWatcher();

      // 3. Perform initial file scan
      await this.#initialFileScan();

      this.#cleanupDeletedFiles();
      this.#startEventQueueProcessor();
      this.#initialScanComplete = true;
      logger.info('FilesStore initialized');
    } catch (error) {
      logger.error('Initialization failed', error);

      if (!this.#shuttingDown) {
        setTimeout(() => this.#reconnect(), this.#reconnectDelay);
      }
    }
  }

  async #initContainer() {
    // Always ensure the container is ready before proceeding
    await this.#dockerClient.ensureContainerReady('default-project');
    logger.info(`Container ready: ${this.#dockerClient.currentContainerId}`);
  }

  async #setupFileWatcher() {
    this.#fileWatcher = await this.#dockerClient.watchPaths(
      {
        include: [`${WORK_DIR}/**`],
        exclude: ['**/node_modules/**', '**/.git/**'],
        includeContent: true,
        pollInterval: 1000,
      },
      (events) => {
        this.#enqueueEvents(events as DockerFileEvent[]);
      },
    );
    logger.info('File watcher initialized');
  }
  async #initialFileScan() {
    logger.info('Starting initial file scan...');
    await this.#scanDirectory(this.#dockerClient.workdir);
    logger.info('Initial file scan completed');
  }

  #enqueueEvents(events: DockerFileEvent[]) {
    this.#eventQueue.push(...events);

    if (!this.#processingQueue) {
      this.#processEventQueue();
    }
  }

  async #processEventQueue() {
    this.#processingQueue = true;

    while (this.#eventQueue.length > 0 && !this.#shuttingDown) {
      const batch = this.#eventQueue.splice(0, 100);

      try {
        await this.#processFileEvents(batch);
      } catch (error) {
        logger.error('Error processing event batch', error);
      }
    }
    this.#processingQueue = false;
  }

  #startEventQueueProcessor() {
    setInterval(() => {
      if (!this.#processingQueue && this.#eventQueue.length > 0) {
        this.#processEventQueue();
      }
    }, 100);
  }

  async #scanDirectory(dirPath: string) {
    try {
      const entries = await this.#dockerClient.readDir(dirPath);

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.type === 'directory') {
          this.files.setKey(fullPath, { type: 'folder' });
          await this.#scanDirectory(fullPath);
        } else {
          try {
            const content = await this.#dockerClient.readFile(fullPath);
            this.files.setKey(fullPath, {
              type: 'file',
              content,
              isBinary: isBinaryFile(Buffer.from(content)),
            });
            this.#size++;
          } catch (error) {
            logger.error(`Failed to read file ${fullPath}`, error);
          }
        }
      }
    } catch (error) {
      logger.error(`Failed to scan directory ${dirPath}`, error);
    }
  }

  #processFileEvents(events: DockerFileEvent[]) {
    const updates: FileMap = {};

    for (const event of events) {
      try {
        const normalizedPath = event.path.replace(/\/+$/g, '');

        switch (event.type) {
          case 'create':
            if (event.isDirectory) {
              updates[normalizedPath] = { type: 'folder' };
            } else {
              const content = event.content || '';
              updates[normalizedPath] = {
                type: 'file',
                content,
                isBinary: isBinaryFile(Buffer.from(content)),
              };
              this.#size++;
            }

            break;

          case 'modify':
            if (!event.isDirectory) {
              const current = this.files.get()[normalizedPath];

              if (current?.type === 'file') {
                const content = event.content || '';
                updates[normalizedPath] = {
                  ...current,
                  content,
                  isBinary: isBinaryFile(Buffer.from(content)),
                };
              }
            }

            break;

          case 'delete':
            updates[normalizedPath] = undefined;

            if (this.files.get()[normalizedPath]?.type === 'file') {
              this.#size--;
            }

            if (event.isDirectory) {
              Object.keys(this.files.get()).forEach((p) => {
                if (p.startsWith(normalizedPath + '/')) {
                  updates[p] = undefined;

                  if (this.files.get()[p]?.type === 'file') {
                    this.#size--;
                  }
                }
              });
            }

            break;

          case 'rename':
            if (event.newPath) {
              this.#processRenameEvent(normalizedPath, event.newPath);
            }

            break;
        }
      } catch (error) {
        logger.error(`Error processing event ${event.type} for ${event.path}`, error);
      }
    }

    if (Object.keys(updates).length > 0) {
      this.files.set({ ...this.files.get(), ...updates });
    }
  }

  async #processRenameEvent(oldPath: string, newPath: string) {
    const file = this.files.get()[oldPath];

    if (!file) {
      return;
    }

    const pendingWrite = this.#pendingWrites.get(oldPath);

    if (pendingWrite) {
      await pendingWrite;
      this.#pendingWrites.delete(oldPath);
    }

    this.files.setKey(newPath, file);
    this.files.setKey(oldPath, undefined);

    if (this.#modifiedFiles.has(oldPath)) {
      this.#modifiedFiles.set(newPath, this.#modifiedFiles.get(oldPath)!);
      this.#modifiedFiles.delete(oldPath);
    }

    if (this.#deletedPaths.has(oldPath)) {
      this.#deletedPaths.delete(oldPath);
      this.#deletedPaths.add(newPath);
    }

    logger.info(`File renamed: ${oldPath} -> ${newPath}`);
  }

  #cleanupDeletedFiles() {
    if (this.#deletedPaths.size === 0) {
      return;
    }

    const currentFiles = this.files.get();
    const updates: FileMap = {};
    let count = 0;

    this.#deletedPaths.forEach((deletedPath) => {
      if (currentFiles[deletedPath]) {
        updates[deletedPath] = undefined;
        count++;
      }
    });

    if (count > 0) {
      this.files.set({ ...currentFiles, ...updates });
      logger.info(`Cleaned up ${count} deleted files`);
    }
  }

  #loadPersistedState() {
    try {
      if (typeof localStorage !== 'undefined') {
        const deletedPaths = localStorage.getItem('bolt-deleted-paths');

        if (deletedPaths) {
          JSON.parse(deletedPaths).forEach((p: string) => this.#deletedPaths.add(p));
        }
      }

      this.#loadLockedFiles();
    } catch (error) {
      logger.error('Failed to load persisted state', error);
    }
  }

  #loadLockedFiles(chatId?: string) {
    try {
      const currentChatId = chatId || getCurrentChatId();
      migrateLegacyLocks(currentChatId);

      const lockedItems = getLockedItemsForChat(currentChatId);

      if (lockedItems.length === 0) {
        return;
      }

      const currentFiles = this.files.get();
      const updates: FileMap = {};

      lockedItems.forEach((item) => {
        const path = item.path;
        const dirent = currentFiles[path];

        if (!dirent) {
          return;
        }

        updates[path] = {
          ...dirent,
          isLocked: true,
          ...(item.isFolder ? {} : { lockedByFolder: item.lockedByFolder }),
        };

        if (item.isFolder) {
          Object.keys(currentFiles).forEach((p) => {
            if (p.startsWith(path + '/') && currentFiles[p]) {
              updates[p] = {
                ...currentFiles[p]!,
                isLocked: true,
                lockedByFolder: path,
              };
            }
          });
        }
      });

      if (Object.keys(updates).length > 0) {
        this.files.set({ ...currentFiles, ...updates });
      }
    } catch (error) {
      logger.error('Failed to load locked files', error);
    }
  }

  async #handleConcurrentWrite(filePath: string, operation: () => Promise<void>) {
    const existingOperation = this.#pendingWrites.get(filePath);

    if (existingOperation) {
      await existingOperation;
    }

    const writePromise = operation();
    this.#pendingWrites.set(filePath, writePromise);

    try {
      await writePromise;
    } finally {
      if (this.#pendingWrites.get(filePath) === writePromise) {
        this.#pendingWrites.delete(filePath);
      }
    }
  }

  async saveFile(filePath: string, content: string | Uint8Array): Promise<void> {
    const dockerClient = await this.#dockerClient;
    const relativePath = path.relative(dockerClient.workdir, filePath);

    // 1. Validate path with proper error handling
    if (!relativePath || relativePath.startsWith('../')) {
      throw new Error(`Invalid file path: ${filePath}`);
    }

    // 2. Get current file state with type guards
    const currentDirent = this.files.get()[filePath];
    const oldContent = currentDirent?.type === 'file' ? currentDirent.content : '';

    // 3. Prepare content with explicit typing
    const isBinary = content instanceof Uint8Array;
    const contentString = isBinary ? Buffer.from(content).toString('base64') : (content as string);

    try {
      // 4. Ensure parent directory exists
      const dirPath = path.dirname(relativePath);

      if (dirPath !== '.') {
        await dockerClient.mkdir(dirPath, { recursive: true });
      }

      // 5. Write to Docker container
      await dockerClient.writeFile(relativePath, content);

      // 6. Create new file object with ALL required properties
      const updatedFile: File = {
        type: 'file',
        content: contentString,
        isBinary,
        isLocked: currentDirent?.type === 'file' ? currentDirent.isLocked : false,
        lockedByFolder: currentDirent?.type === 'file' ? currentDirent.lockedByFolder : undefined,
      };

      // 7. Update state
      if (!this.#modifiedFiles.has(filePath)) {
        this.#modifiedFiles.set(filePath, oldContent);
      }

      this.files.setKey(filePath, updatedFile);
      logger.info(`File saved: ${filePath} (${isBinary ? 'binary' : 'text'})`);
    } catch (error) {
      logger.error(`Failed to save file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(`Failed to save file: ${filePath}`);
    }
  }

  getFileModifications() {
    return computeFileModifications(this.files.get(), this.#modifiedFiles);
  }

  getModifiedFiles() {
    const modifiedFiles: Record<string, File> = {};
    this.#modifiedFiles.forEach((originalContent, filePath) => {
      const file = this.files.get()[filePath];

      if (file?.type === 'file' && file.content !== originalContent) {
        modifiedFiles[filePath] = file;
      }
    });

    return Object.keys(modifiedFiles).length > 0 ? modifiedFiles : undefined;
  }

  resetFileModifications() {
    this.#modifiedFiles.clear();
  }

  async createFile(filePath: string, content: string | Uint8Array = ''): Promise<void> {
    const dockerClient = await this.#dockerClient;
    const relativePath = path.relative(dockerClient.workdir, filePath);

    if (!relativePath) {
      throw new Error(`Invalid file path: ${filePath}`);
    }

    await this.#handleConcurrentWrite(filePath, async () => {
      try {
        // 1. Ensure parent directory exists
        const dirPath = path.dirname(relativePath);

        if (dirPath !== '.') {
          await dockerClient.mkdir(dirPath, { recursive: true });
        }

        // 2. Handle binary/text content
        const isBinary = content instanceof Uint8Array;
        const contentToWrite = isBinary ? content : content || ' ';
        const storedContent = isBinary ? Buffer.from(content).toString('base64') : (content as string);

        // 3. Write to filesystem
        await dockerClient.writeFile(relativePath, contentToWrite);

        // 4. Create type-safe file object
        const current = this.files.get()[filePath];
        const newFile: File = {
          type: 'file',
          content: storedContent,
          isBinary,
          isLocked: isFile(current) ? current.isLocked : false,
          lockedByFolder: isFile(current) ? current.lockedByFolder : undefined,
        };

        // 5. Update state
        this.files.setKey(filePath, newFile);
        this.#modifiedFiles.set(filePath, storedContent);

        logger.info(`File created: ${filePath}`);
      } catch (error) {
        logger.error(`Failed to create file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    });
  }

  async createFolder(folderPath: string): Promise<boolean> {
    const dockerClient = await this.#dockerClient;
    const relativePath = path.relative(dockerClient.workdir, folderPath);

    if (!relativePath) {
      throw new Error(`Invalid folder path: ${folderPath}`);
    }

    try {
      await dockerClient.mkdir(relativePath, { recursive: true });

      // Get current state with type guard
      const current = this.files.get()[folderPath];
      const newFolder: Folder = {
        type: 'folder',
        isLocked: isFolder(current) ? current.isLocked : false,
        lockedByFolder: isFolder(current) ? current.lockedByFolder : undefined,
      };

      this.files.setKey(folderPath, newFolder);
      logger.info(`Folder created: ${folderPath}`);

      return true;
    } catch (error) {
      logger.error(`Failed to create folder ${folderPath}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const dockerClient = await this.#dockerClient;
    const relativePath = path.relative(dockerClient.workdir, filePath);

    if (!relativePath) {
      throw new Error(`Invalid file path: ${filePath}`);
    }

    await this.#handleConcurrentWrite(filePath, async () => {
      try {
        await dockerClient.rm(relativePath);
        this.#deletedPaths.add(filePath);

        // Type-safe access
        const current = this.files.get()[filePath];

        if (isFile(current)) {
          // <-- Using type guard
          this.#size--;
        }

        this.files.setKey(filePath, undefined);
        this.#modifiedFiles.delete(filePath);
        this.#persistDeletedPaths();
      } catch (error) {
        logger.error(`Failed to delete file ${filePath}`, error);
        throw error;
      }
    });
  }

  async deleteFolder(folderPath: string): Promise<boolean> {
    const dockerClient = await this.#dockerClient;
    const relativePath = path.relative(dockerClient.workdir, folderPath);

    if (!relativePath) {
      throw new Error(`Invalid folder path: ${folderPath}`);
    }

    try {
      await dockerClient.rm(relativePath, { recursive: true });
      this.#deletedPaths.add(folderPath);

      const allFiles = this.files.get();
      const updates: FileMap = {};
      updates[folderPath] = undefined;

      Object.entries(allFiles).forEach(([path, dirent]) => {
        if (path.startsWith(`${folderPath}/`)) {
          updates[path] = undefined;

          if (isFile(dirent)) {
            // <-- Using type guard
            this.#size--;
          }

          this.#modifiedFiles.delete(path);
          this.#deletedPaths.add(path);
        }
      });

      this.files.set({ ...allFiles, ...updates });
      this.#persistDeletedPaths();

      return true;
    } catch (error) {
      logger.error(`Failed to delete folder ${folderPath}`, error);
      throw error;
    }
  }
  async moveFile(sourcePath: string, destinationPath: string) {
    const dockerClient = await this.#dockerClient;
    const relativeSource = path.relative(dockerClient.workdir, sourcePath);
    const relativeDest = path.relative(dockerClient.workdir, destinationPath);

    if (!relativeSource || !relativeDest) {
      throw new Error('Invalid path for move operation');
    }

    await this.#handleConcurrentWrite(sourcePath, async () => {
      try {
        await dockerClient.mv(relativeSource, relativeDest);
        await this.#processRenameEvent(sourcePath, destinationPath);
      } catch (error) {
        logger.error(`Failed to move file ${sourcePath} to ${destinationPath}`, error);
        throw error;
      }
    });
  }

  async copyFile(sourcePath: string, destinationPath: string) {
    const dockerClient = await this.#dockerClient;
    const relativeSource = path.relative(dockerClient.workdir, sourcePath);
    const relativeDest = path.relative(dockerClient.workdir, destinationPath);

    if (!relativeSource || !relativeDest) {
      throw new Error('Invalid path for copy operation');
    }

    await this.#handleConcurrentWrite(destinationPath, async () => {
      try {
        await dockerClient.cp(relativeSource, relativeDest);

        const sourceFile = this.files.get()[sourcePath];

        if (sourceFile?.type === 'file') {
          const content = await dockerClient.readFile(relativeDest);
          this.files.setKey(destinationPath, {
            type: 'file',
            content,
            isBinary: sourceFile.isBinary,
            isLocked: false,
          });
          this.#size++;
        }
      } catch (error) {
        logger.error(`Failed to copy file ${sourcePath} to ${destinationPath}`, error);
        throw error;
      }
    });
  }

  async getFileStats(filePath: string) {
    const dockerClient = await this.#dockerClient;
    const relativePath = path.relative(dockerClient.workdir, filePath);

    if (!relativePath) {
      throw new Error(`Invalid file path: ${filePath}`);
    }

    try {
      const statsStr = await dockerClient.executeCommand(`stat -c '%s %Y %F' "${relativePath}"`);
      const [size, mtime, type] = statsStr.trim().split(' ');

      return {
        size: parseInt(size, 10),
        mtime: parseInt(mtime, 10),
        isDirectory: type === 'directory',
        isFile: type === 'regular file',
      };
    } catch (error) {
      logger.error(`Failed to get stats for ${filePath}`, error);
      throw error;
    }
  }

  async fileExists(filePath: string) {
    try {
      await this.getFileStats(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async directoryExists(dirPath: string) {
    try {
      const stats = await this.getFileStats(dirPath);
      return stats.isDirectory;
    } catch {
      return false;
    }
  }

  async getFileHash(filePath: string) {
    const dockerClient = await this.#dockerClient;
    const relativePath = path.relative(dockerClient.workdir, filePath);

    if (!relativePath) {
      throw new Error(`Invalid file path: ${filePath}`);
    }

    try {
      return await dockerClient.executeCommand(`sha256sum "${relativePath}" | cut -d ' ' -f 1`);
    } catch (error) {
      logger.error(`Failed to get hash for ${filePath}`, error);
      throw error;
    }
  }

  async #acquireFileLock(filePath: string) {
    const lockKey = `file-lock:${filePath}`;
    const maxAttempts = 5;
    let attempts = 0;

    while (attempts < maxAttempts && !this.#shuttingDown) {
      if (!this.#activeLocks.has(lockKey)) {
        this.#activeLocks.set(lockKey, true);
        logger.debug(`Acquired lock for ${filePath}`);

        return {
          release: () => {
            this.#activeLocks.delete(lockKey);
            logger.debug(`Released lock for ${filePath}`);
          },
        };
      }

      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempts));
    }

    throw new Error(`Failed to acquire lock for ${filePath} after ${maxAttempts} attempts`);
  }

  async atomicFileUpdate(filePath: string, updateFn: (currentContent: string) => string | Promise<string>) {
    const lock = await this.#acquireFileLock(filePath);

    try {
      const currentContent = await this.readFile(filePath);
      const newContent = await updateFn(currentContent);
      await this.saveFile(filePath, newContent);
    } finally {
      lock.release();
    }
  }

  async readFile(filePath: string): Promise<string> {
    const dockerClient = await this.#dockerClient;
    const relativePath = path.relative(dockerClient.workdir, filePath);

    if (!relativePath) {
      throw new Error(`Invalid file path: ${filePath}`);
    }

    try {
      return await dockerClient.readFile(relativePath);
    } catch (error) {
      logger.error(`Failed to read file ${filePath}`, error);
      throw error;
    }
  }

  async #recoverFromWatchFailure() {
    logger.warn('Attempting to recover from file watch failure');

    try {
      if (this.#fileWatcher) {
        this.#fileWatcher.close();
        this.#fileWatcher = null;
      }

      await this.#setupFileWatcher();

      if (this.#initialScanComplete) {
        await this.#initialFileScan();
      }

      logger.info('Successfully recovered file watcher');
      this.#reconnectAttempts = 0;
    } catch (error) {
      this.#reconnectAttempts++;
      logger.error(`Failed to recover file watcher (attempt ${this.#reconnectAttempts})`, error);

      if (this.#reconnectAttempts < this.#maxReconnectAttempts && !this.#shuttingDown) {
        setTimeout(() => this.#recoverFromWatchFailure(), this.#reconnectDelay);
      }
    }
  }

  async verifyFilesystemIntegrity() {
    const dockerClient = await this.#dockerClient;

    try {
      const result = await dockerClient.executeCommand('find /app -type f -exec sha256sum {} + | sort | sha256sum');
      return result.trim();
    } catch (error) {
      logger.error('Filesystem integrity check failed', error);
      throw error;
    }
  }

  async #reconnect() {
    if (this.#shuttingDown) {
      return;
    }

    this.#reconnectAttempts++;

    if (this.#reconnectAttempts > this.#maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      return;
    }

    logger.info(`Attempting to reconnect (${this.#reconnectAttempts}/${this.#maxReconnectAttempts})`);

    try {
      await this.#init();
      this.#reconnectAttempts = 0;
    } catch (error) {
      logger.error(`Reconnect attempt ${this.#reconnectAttempts} failed`, error);
      setTimeout(() => this.#reconnect(), this.#reconnectDelay);
    }
  }

  async destroy() {
    this.#shuttingDown = true;

    try {
      if (this.#fileWatcher) {
        this.#fileWatcher.close();
        this.#fileWatcher = null;
      }

      this.#pendingWrites.clear();
      this.#activeLocks.clear();
      logger.info('FilesStore destroyed');
    } catch (error) {
      logger.error('Error during destruction', error);
    }
  }

  #persistDeletedPaths() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('bolt-deleted-paths', JSON.stringify([...this.#deletedPaths]));
      }
    } catch (error) {
      logger.error('Failed to persist deleted paths', error);
    }
  }

  // Complete type-safe implementation
  lockFile(filePath: string, chatId?: string): boolean {
    const current = this.files.get()[filePath];
    const currentChatId = chatId || getCurrentChatId();

    if (!isFileObject(current)) {
      logger.error(`Cannot lock non-existent file: ${filePath}`);
      return false;
    }

    this.files.setKey(filePath, {
      ...current,
      isLocked: true,
    });

    addLockedFile(currentChatId, filePath);

    return true;
  }

  unlockFile(filePath: string, chatId?: string): boolean {
    const current = this.files.get()[filePath];
    const currentChatId = chatId || getCurrentChatId();

    if (!isFileObject(current)) {
      logger.error(`Cannot unlock non-existent file: ${filePath}`);
      return false;
    }

    this.files.setKey(filePath, {
      ...current,
      isLocked: false,
      lockedByFolder: undefined,
    });

    removeLockedFile(currentChatId, filePath);

    return true;
  }

  lockFolder(folderPath: string, chatId?: string): boolean {
    const current = this.files.get()[folderPath];
    const currentChatId = chatId || getCurrentChatId();

    if (!isFolderObject(current)) {
      logger.error(`Cannot lock non-existent folder: ${folderPath}`);
      return false;
    }

    // Update the folder itself
    this.files.setKey(folderPath, {
      ...current,
      isLocked: true,
    });

    // Update all contents
    const updates: FileMap = {};
    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    Object.entries(this.files.get()).forEach(([path, dirent]) => {
      if (path.startsWith(folderPrefix) && dirent) {
        if (isFileObject(dirent)) {
          updates[path] = {
            ...dirent,
            isLocked: true,
            lockedByFolder: folderPath,
          };
        } else if (isFolderObject(dirent)) {
          updates[path] = {
            ...dirent,
            isLocked: true,
            lockedByFolder: folderPath,
          };
        }
      }
    });

    this.files.set({ ...this.files.get(), ...updates });
    addLockedFolder(currentChatId, folderPath);

    return true;
  }

  unlockFolder(folderPath: string, chatId?: string): boolean {
    const current = this.files.get()[folderPath];
    const currentChatId = chatId || getCurrentChatId();

    if (!isFolderObject(current)) {
      logger.error(`Cannot unlock non-existent folder: ${folderPath}`);
      return false;
    }

    // Update the folder itself
    this.files.setKey(folderPath, {
      ...current,
      isLocked: false,
      lockedByFolder: undefined,
    });

    // Update all contents
    const updates: FileMap = {};
    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    Object.entries(this.files.get()).forEach(([path, dirent]) => {
      if (path.startsWith(folderPrefix) && dirent) {
        if (isFileObject(dirent) && dirent.lockedByFolder === folderPath) {
          updates[path] = {
            ...dirent,
            isLocked: false,
            lockedByFolder: undefined,
          };
        } else if (isFolderObject(dirent) && dirent.lockedByFolder === folderPath) {
          updates[path] = {
            ...dirent,
            isLocked: false,
            lockedByFolder: undefined,
          };
        }
      }
    });

    this.files.set({ ...this.files.get(), ...updates });
    removeLockedFolder(currentChatId, folderPath);

    return true;
  }

  getFile(filePath: string): File | undefined {
    const dirent = this.files.get()[filePath];
    return isFileObject(dirent) ? dirent : undefined;
  }

  getFileOrFolder(path: string): Dirent | undefined {
    const dirent = this.files.get()[path];
    return isFileObject(dirent) || isFolderObject(dirent) ? dirent : undefined;
  }

  isFileLocked(filePath: string, chatId?: string): { locked: boolean; lockedBy?: string } {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      return { locked: false };
    }

    if (file.isLocked) {
      return {
        locked: true,
        lockedBy: file.lockedByFolder || filePath,
      };
    }

    const lockedFiles = getLockedFilesForChat(currentChatId);

    if (lockedFiles.some((item) => item.path === filePath)) {
      return { locked: true, lockedBy: filePath };
    }

    return isPathInLockedFolder(currentChatId, filePath);
  }

  isFolderLocked(folderPath: string, chatId?: string): { isLocked: boolean; lockedBy?: string } {
    const folder = this.getFileOrFolder(folderPath);
    const currentChatId = chatId || getCurrentChatId();

    if (!isFolderObject(folder)) {
      return { isLocked: false };
    }

    if (folder.isLocked) {
      return { isLocked: true, lockedBy: folderPath };
    }

    const lockedFolders = getLockedFoldersForChat(currentChatId);

    if (lockedFolders.some((item) => item.path === folderPath)) {
      return { isLocked: true, lockedBy: folderPath };
    }

    return { isLocked: false };
  }
}

function isBinaryFile(buffer: Buffer): boolean {
  return getEncoding(buffer, { chunkLength: 100 }) === 'binary';
}

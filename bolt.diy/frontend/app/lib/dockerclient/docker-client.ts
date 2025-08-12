// app/lib/dockerclient/docker-client.ts
import { WORK_DIR } from '~/utils/constants';
import { EventEmitter } from 'events';

export interface ICommandResponse {
  type: 'output' | 'error' | 'end';
  data: string;
  messageId?: string;
}

export interface IStartProjectResponse {
  containerId: string;
  status: 'success' | 'failed';
  message?: string;
  ports?: { [internalPort: string]: string };
}

export interface WatchOptions {
  include: string[];
  exclude?: string[];
  includeContent?: boolean;
  pollInterval?: number;
  ignoreInitial?: boolean;
}

export interface FileEvent {
  type: 'create' | 'modify' | 'delete';
  path: string;
  content?: string;
}

export class DockerClient extends EventEmitter {
  readonly workdir = '/app';
  private _watchers: Map<string, { close: () => void }> = new Map();
  private _socket: WebSocket | null = null;
  private _isConnecting = false;
  private _connectionPromise: Promise<void> | null = null;
  private readonly _baseUrl: string;
  private _messageHandlers: Map<string, (data: ICommandResponse) => void> = new Map();
  private _autoReconnect = true;
  private _maxConnectionAttempts = 3;
  private _reconnectDelay = 1000;
  private _currentContainerId: string | null = null;
  private _containerReady: Promise<void> | null = null;
  private _currentProjectId: string | null = null;
  private _pendingStart: Map<string, Promise<IStartProjectResponse>> = new Map();
  private _containerValidation: Map<string, Promise<boolean>> = new Map();

  constructor(baseUrl?: string) {
    super();
    this._baseUrl = baseUrl || process.env.REACT_APP_API_URL || 'http://localhost:3001';
  }

  private async _validateContainer(containerId: string): Promise<boolean> {
    if (this._containerValidation.has(containerId)) {
      return this._containerValidation.get(containerId)!;
    }

    const validationPromise = (async () => {
      try {
        const response = await fetch(`${this._baseUrl}/api/containers/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ containerId }),
        });
        
        if (!response.ok) {
          return false;
        }
        
        const data: unknown = await response.json();
        
        if (
          typeof data === 'object' && 
          data !== null && 
          'status' in data && 
          typeof (data as any).status === 'string'
        ) {
          return (data as { status: string }).status === 'running';
        }
        
        return false;
      } catch (error) {
        console.error('Container validation failed:', error);
        return false;
      }
    })();

    this._containerValidation.set(containerId, validationPromise);
    
    setTimeout(() => {
      this._containerValidation.delete(containerId);
    }, 30000);

    return validationPromise;
  }

  async startProject(projectId: string): Promise<IStartProjectResponse> {
    if (this._currentProjectId === projectId && this._currentContainerId) {
      const isValid = await this._validateContainer(this._currentContainerId);
      if (isValid) {
        console.info(`Reusing existing container for project ${projectId}: ${this._currentContainerId}`);
        return {
          containerId: this._currentContainerId,
          status: 'success',
          message: 'Reused existing container',
        };
      } else {
        console.warn(`Container ${this._currentContainerId} is no longer valid, creating new one`);
        this._currentContainerId = null;
        this._containerReady = null;
      }
    }

    if (this._pendingStart.has(projectId)) {
      return this._pendingStart.get(projectId)!;
    }

    const promise = (async () => {
      try {
        if (this._currentProjectId !== projectId) {
          this._currentContainerId = null;
          this._containerReady = null;
          this._currentProjectId = projectId;
        }

        const response = await fetch(`${this._baseUrl}/api/projects/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!this._isStartProjectResponse(data)) {
          throw new Error('Invalid response format from server');
        }

        this._currentContainerId = data.containerId;
        this._currentProjectId = projectId;

        const isValid = await this._validateContainer(data.containerId);

        if (!isValid) {
          throw new Error('Container validation failed after creation');
        }

        this._containerReady = this._verifyContainerReady();

        return data;
      } catch (error) {
        this._currentContainerId = null;
        this._containerReady = null;
        throw error;
      }
    })();

    this._pendingStart.set(projectId, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this._pendingStart.delete(projectId);
    }
  }

  async ensureContainerReady(projectId?: string): Promise<void> {
    await this.connect();

    const targetProjectId = projectId || this._currentProjectId || 'default-project';

    if (
      !this._currentContainerId ||
      !(await this._validateContainer(this._currentContainerId)) ||
      this._currentProjectId !== targetProjectId
    ) {
      await this.startProject(targetProjectId);
    }

    if (!this._containerReady) {
      this._containerReady = this._verifyContainerReady();
    }

    await this._containerReady;
  }

  private async _verifyContainerReady(): Promise<void> {
    const maxAttempts = 60; // Increased timeout
    const delay = 2000;     // Increased delay

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!this._currentContainerId || !(await this._validateContainer(this._currentContainerId))) {
          throw new Error('Container no longer exists');
        }

        const output = await this._executeCommandInternal('echo "ready"');

        if (output.includes('ready')) {
          this.emit('containerReady');
          return;
        }
      } catch (error) {
        console.log(`Container not ready yet (attempt ${attempt}/${maxAttempts}), ${error}`);

        if (error instanceof Error && error.message.includes('no longer exists')) {
          throw error;
        }
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('Container did not become ready within timeout');
  }

  async connect(): Promise<void> {
    if (this._socket?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this._isConnecting && this._connectionPromise) {
      await this._connectionPromise;
      return;
    }

    this._isConnecting = true;
    this._connectionPromise = this._attemptConnection();
    await this._connectionPromise;
    this._isConnecting = false;
  }

  private async _attemptConnection(): Promise<void> {
    const wsUrl = this._baseUrl.replace(/^http/, 'ws') + '/ws';

    for (let attempt = 1; attempt <= this._maxConnectionAttempts; attempt++) {
      try {
        const socket = new WebSocket(wsUrl);
        this._socket = socket;

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('WebSocket connection timed out'));
            this._cleanupSocket(socket);
          }, 10000);

          const cleanup = () => {
            clearTimeout(timeout);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', onError);
          };

          const onOpen = () => {
            cleanup();
            this._setupSocketListeners(socket);
            resolve();
          };

          const onError = (event: Event) => {
            cleanup();
            reject(new Error(`WebSocket error: ${(event as ErrorEvent).message}`));
            this._cleanupSocket(socket);
          };

          socket.addEventListener('open', onOpen, { once: true });
          socket.addEventListener('error', onError, { once: true });
        });

        return;
      } catch (error) {
        console.error(`WebSocket connection attempt ${attempt} failed:`, error);

        if (attempt >= this._maxConnectionAttempts) {
          throw error;
        }

        const delay = Math.min(this._reconnectDelay * Math.pow(2, attempt - 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private _setupSocketListeners(socket: WebSocket): void {
    socket.addEventListener('message', this._handleMessage);
    socket.addEventListener('close', this._handleClose);
    socket.addEventListener('error', this._handleError);
  }

  private _cleanupSocket(socket: WebSocket | null): void {
    if (!socket) {
      return;
    }

    socket.removeEventListener('message', this._handleMessage);
    socket.removeEventListener('close', this._handleClose);
    socket.removeEventListener('error', this._handleError);

    if (socket === this._socket) {
      this._socket = null;
    }

    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }

  private _handleMessage = (event: MessageEvent) => {
    try {
      let message: ICommandResponse;

      try {
        message = JSON.parse(event.data);
      } catch (e) {
        message = { type: 'output', data: event.data, messageId: 'raw-output' };
      }

      if (!message.messageId) {
        return;
      }

      const handler = this._messageHandlers.get(message.messageId);

      if (handler) {
        handler(message);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  };

  private _handleClose = () => {
    console.log('WebSocket connection closed');
    this._cleanupSocket(this._socket);

    if (this._autoReconnect) {
      setTimeout(() => {
        if (!this._isConnecting && !this._socket) {
          this.connect().catch((error) => {
            console.error('Reconnection failed:', error);
          });
        }
      }, 2000);
    }
  };

  private _handleError = (error: Event) => {
    const errorMessage = error instanceof ErrorEvent ? error.message : 'Unknown WebSocket error';
    console.error('WebSocket error:', errorMessage);
    this._cleanupSocket(this._socket);

    const wsError = new Error(errorMessage);
    this._messageHandlers.forEach((handler) => {
      handler({ type: 'error', data: wsError.message });
    });
    this._messageHandlers.clear();
  };

  async executeCommand(command: string): Promise<string> {
    await this.ensureContainerReady();

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    const isValid = await this._validateContainer(this._currentContainerId);

    if (!isValid) {
      console.warn('Container validation failed, forcing container recreation');
      this._currentContainerId = null;
      this._containerReady = null;
      await this.ensureContainerReady();
    }

    return this._executeCommandInternal(command);
  }

  private async _executeCommandInternal(command: string): Promise<string> {
    if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection not established');
    }

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    const messageId = crypto.randomUUID();
    const output: string[] = [];

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this._messageHandlers.delete(messageId);
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Command execution timed out (30 seconds)'));
      }, 30000);

      this._messageHandlers.set(messageId, (response: ICommandResponse) => {
        try {
          switch (response.type) {
            case 'output':
              output.push(response.data);
              break;
            case 'error':
              cleanup();
              clearTimeout(timeoutId);

              if (response.data.includes('No such container')) {
                console.warn('Container not found error, clearing state for recreation');
                this._currentContainerId = null;
                this._containerReady = null;
              }

              reject(new Error(response.data));
              break;
            case 'end':
              cleanup();
              clearTimeout(timeoutId);
              resolve(output.join(''));
              break;
          }
        } catch (error) {
          cleanup();
          clearTimeout(timeoutId);
          reject(error);
        }
      });

      try {
        if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
          throw new Error('WebSocket connection lost');
        }

        this._socket.send(
          JSON.stringify({
            messageId,
            containerId: this._currentContainerId,
            command,
          }),
        );
      } catch (error) {
        cleanup();
        clearTimeout(timeoutId);
        reject(new Error(`Failed to send command: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  async readFile(filePath: string): Promise<string> {
    await this.ensureContainerReady();

    try {
      const content = await this.executeCommand(`cat "${filePath}"`);
      return content;
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.ensureContainerReady();

    const dirname = path.substring(0, path.lastIndexOf('/'));

    if (dirname && dirname !== '/app') {
      await this.mkdir(dirname, { recursive: true });
    }

    if (content instanceof Uint8Array) {
      const base64Content = Buffer.from(content).toString('base64');
      await this.executeCommand(`echo '${base64Content}' | base64 -d > "${path}"`);
    } else {
      // ✅ FIXED: Better content escaping for special characters
      const escapedContent = content.replace(/'/g, `'"'"'`);
      await this.executeCommand(`printf '%s' '${escapedContent}' > "${path}"`);
    }
  }

  async readDir(dirPath: string): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
    await this.ensureContainerReady();

    try {
      // ✅ FIXED: Use BusyBox-compatible ls command
      const lsOutput = await this.executeCommand(`ls -la "${dirPath}" 2>/dev/null | tail -n +2 | grep -v '^total'`);
      return lsOutput
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          const perms = parts[0];
          const name = parts.slice(8).join(' '); // Handle filenames with spaces
          return {
            name,
            type: perms.startsWith('d') ? ('directory' as const) : ('file' as const),
          };
        })
        .filter((item) => item.name && !['.', '..'].includes(item.name));
    } catch (error) {
      throw new Error(`Failed to read directory ${dirPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.ensureContainerReady();

    const cmd = options.recursive ? `mkdir -p "${path}"` : `mkdir "${path}"`;
    await this.executeCommand(cmd);
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.ensureContainerReady();

    const flags = [options.recursive ? '-r' : '', options.force ? '-f' : ''].filter(Boolean).join(' ');
    await this.executeCommand(`rm ${flags} "${path}"`);
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureContainerReady();

    try {
      await this.executeCommand(`test -e "${path}"`);
      return true;
    } catch {
      return false;
    }
  }

  async cp(source: string, destination: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.ensureContainerReady();

    const flags = options.recursive ? '-r' : '';
    await this.executeCommand(`cp ${flags} "${source}" "${destination}"`);
  }

  async mv(source: string, destination: string): Promise<void> {
    await this.ensureContainerReady();
    await this.executeCommand(`mv "${source}" "${destination}"`);
  }

  async watchPaths(options: WatchOptions, callback: (events: FileEvent[]) => void): Promise<{ close: () => void }> {
    await this.ensureContainerReady();
    await this.connect();

    const watchId = crypto.randomUUID();
    const pollInterval = options.pollInterval || 5000;
    
    // ✅ FIXED: Use BusyBox-compatible find commands
    const includePatterns = options.include.map((p) => p.replace(`${WORK_DIR}/`, '/app/'));
    const excludePatterns = options.exclude || ['**/node_modules/**', '**/.git/**'];

    let isWatching = true;
    let lastSnapshot: Record<string, { mtime: number; content?: string }> = {};

    const poll = async () => {
      if (!isWatching) {
        return;
      }

      try {
        if (!this._currentContainerId || !(await this._validateContainer(this._currentContainerId))) {
          console.log('Container validation failed, attempting to recover...');
          await this.ensureContainerReady();
        }

        if (!this.isConnected) {
          await this.connect();
        }

        // ✅ FIXED: Use BusyBox-compatible find command instead of -printf
        let findCmd = 'find /app -type f';
        
        // Add include patterns (convert glob patterns to find-compatible)
        if (includePatterns.length > 0) {
          const namePatterns = includePatterns.map(p => {
            // Convert **/*.js to -name "*.js"
            const ext = p.split('*').pop();
            return `-name "*${ext}"`;
          }).join(' -o ');
          findCmd += ` \\( ${namePatterns} \\)`;
        }
        
        // Add exclude patterns
        for (const exclude of excludePatterns) {
          const excludePath = exclude.replace('**/', '*/').replace('/**', '/*');
          findCmd += ` ! -path "${excludePath}"`;
        }
        
        // ✅ Use stat instead of -printf
        findCmd += ' -exec stat -c "%Y %n" {} \\;';

        const output = await this.executeCommand(findCmd);
        const currentFiles: Record<string, { mtime: number; content?: string }> = {};

        for (const line of output.split('\n').filter(Boolean)) {
          const spaceIndex = line.indexOf(' ');

          if (spaceIndex === -1) {
            continue;
          }

          const mtimeStr = line.substring(0, spaceIndex);
          const filePath = line.substring(spaceIndex + 1);
          const mtime = parseFloat(mtimeStr);

          currentFiles[filePath] = { mtime };

          if (options.includeContent) {
            try {
              currentFiles[filePath].content = await this.readFile(filePath);
            } catch {}
          }
        }

        const changes: FileEvent[] = [];
        const allPaths = new Set([...Object.keys(lastSnapshot), ...Object.keys(currentFiles)]);

        for (const filePath of allPaths) {
          const prev = lastSnapshot[filePath];
          const current = currentFiles[filePath];

          if (!prev && current) {
            changes.push({ type: 'create', path: filePath, content: current.content });
          } else if (prev && !current) {
            changes.push({ type: 'delete', path: filePath });
          } else if (prev && current && prev.mtime !== current.mtime) {
            changes.push({ type: 'modify', path: filePath, content: current.content });
          }
        }

        if (changes.length > 0) {
          callback(changes);
        }

        lastSnapshot = currentFiles;
      } catch (error) {
        console.error('File watch error:', error);

        if (error instanceof Error && error.message.includes('No such container')) {
          this._currentContainerId = null;
          this._containerReady = null;
        }
      } finally {
        if (isWatching) {
          setTimeout(poll, pollInterval);
        }
      }
    };

    // ✅ FIXED: Add initial delay to prevent immediate polling
    setTimeout(poll, 1000);

    const watcher = {
      close: () => {
        isWatching = false;
        this._watchers.delete(watchId);
      },
    };

    this._watchers.set(watchId, watcher);

    return watcher;
  }

  private _isStartProjectResponse(response: unknown): response is IStartProjectResponse {
    const r = response as IStartProjectResponse;
    return (
      typeof r === 'object' &&
      r !== null &&
      typeof r.containerId === 'string' &&
      (r.status === 'success' || r.status === 'failed')
    );
  }

  private _escapeShellContent(content: string): string {
    return content.replace(/'/g, `'\\''`).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  }

  get isConnected(): boolean {
    return this._socket?.readyState === WebSocket.OPEN;
  }

  get currentContainerId(): string | null {
    return this._currentContainerId;
  }

  get currentProjectId(): string | null {
    return this._currentProjectId;
  }

  disconnect(): void {
    this._autoReconnect = false;
    this._cleanupSocket(this._socket);
    this._currentContainerId = null;
    this._containerReady = null;
    this._watchers.forEach((watcher) => watcher.close());
    this._watchers.clear();
  }
}

import { WORK_DIR } from '~/utils/constants';
import { EventEmitter } from 'events';

interface ICommandResponse {
  type: 'output' | 'error' | 'end';
  data: string;
  messageId?: string;
}

interface ExecCreateResponse {
  execId: string;
}

interface IStartProjectResponse {
  containerId: string;
  status: 'success' | 'failed';
  message?: string;
  ports?: { [internalPort: string]: string };
}

interface IContainerStatus {
  containerId: string;
  status: 'running' | 'stopped' | 'error';
  ports?: { [internalPort: string]: string };
}

interface WatchOptions {
  include: string[];
  exclude?: string[];
  includeContent?: boolean;
  pollInterval?: number;
  maxDepth?: number;
  ignoreInitial?: boolean;
}

interface ExecOptions {
  containerId: string;
  command: string[];
  interactive: boolean;
  tty: boolean;
  cols?: number;
  rows?: number;
}

interface ExecStreams {
  input: WritableStream<string>;
  output: ReadableStream<string>;
}

interface IFileTransferResponse {
  status: 'success' | 'failed';
  message?: string;
}

interface FileEvent {
  type: 'create' | 'modify' | 'delete';
  path: string;
  content?: string;
}

export class DockerClient extends EventEmitter {
  readonly workdir = '/app';
  private _watchers: Map<string, { close: () => void }> = new Map();
  private _watchEventBuffer: ((events: FileEvent[]) => void) | null = null;
  private _watchDebounceTimer: NodeJS.Timeout | null = null;
  private _socket: WebSocket | null = null;
  private _isConnecting = false;
  private _connectionPromise: Promise<void> | null = null;
  private readonly _baseUrl: string;
  private _messageHandlers: Map<string, (data: ICommandResponse) => void> = new Map();
  private _connectionAttempts = 0;
  private _autoReconnect = true;
  private _maxConnectionAttempts = 3;
  private _reconnectDelay = 1000;
  private _currentContainerReady: Promise<void> | null = null;
  private _assignedPorts: { [internalPort: string]: string } = {};
  private _containerReadyPromise: Promise<void> | null = null;
  private _currentContainerId: string | null = null;
  private _containerReady: Promise<void> | null = null;
  private _lastProjectId: string | null = null;
  private _pendingStart: Map<string, Promise<IStartProjectResponse>> = new Map();

  constructor(baseUrl?: string) {
    super();
    this._baseUrl = baseUrl || process.env.REACT_APP_API_URL || 'http://localhost:3001';
  }

  /**
   * Ensures the container is started and ready before running the callback.
   * Use this for any code that needs the container to be ready.
   */
  async withReadyContainer<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    await this.startProject(projectId);
    await this.ensureContainerReady();

    return fn();
  }

  // --- Container lifecycle and readiness enforcement ---

  // Replace your startProject with:
  async startProject(projectId: string): Promise<IStartProjectResponse> {
    if (this._pendingStart.has(projectId)) {
      return this._pendingStart.get(projectId)!;
    }

    const promise = (async () => {
      this._currentContainerId = null;
      this._containerReady = null;
      this._lastProjectId = projectId;

      const response = await fetch(`${this._baseUrl}/api/projects/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });

      const data = await response.json();

      if (!this._isStartProjectResponse(data)) {
        throw new Error('Invalid response format from server');
      }

      this._currentContainerId = data.containerId;
      this._containerReady = this._verifyContainerReady();

      return data;
    })();

    this._pendingStart.set(projectId, promise);

    try {
      return await promise;
    } finally {
      this._pendingStart.delete(projectId);
    }
  }

  async ensureContainerReady(projectId?: string): Promise<void> {
    await this.connect(); // <-- Ensure WebSocket is connected before anything else

    if (!this._containerReady) {
      if (!this._currentContainerId) {
        if (!projectId && !this._lastProjectId) {
          throw new Error('No projectId provided and no previous project started.');
        }

        await this.startProject(projectId || this._lastProjectId!);
      }

      this._containerReady = this._verifyContainerReady();
    }

    await this._containerReady;
  }

  private async _verifyContainerReady(): Promise<void> {
    const maxAttempts = 30;
    const delay = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const output = await this._executeCommandInternal('echo "ready"');

        if (output.includes('ready')) {
          this.emit('containerReady');
          return;
        }
      } catch (error) {
        console.log(`Container not ready yet (attempt ${attempt}/${maxAttempts}), ${error}`);
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('Container did not become ready within timeout');
  }

  // --- WebSocket management ---

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
          }, 5000);
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
        console.log(e);
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
      }, 1000);
    }
  };

  private _handleError = (error: Event) => {
    const errorMessage = error instanceof ErrorEvent ? error.message : 'Unknown WebSocket error';
    console.error('WebSocket error:', errorMessage);
    this._cleanupSocket(this._socket);

    const wsError = new Error(errorMessage);
    this._messageHandlers.forEach((handler, messageId) => {
      handler({ type: 'error', data: wsError.message, messageId });
    });
    this._messageHandlers.clear();
  };

  // --- Command execution ---

  async executeCommand(command: string): Promise<string> {
    await this.ensureContainerReady();

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    return this._executeCommandInternal(command);
  }

  private async _executeCommandInternal(command: string): Promise<string> {
    if (!this._socket) {
      throw new Error('WebSocket connection not established');
    }

    if (this._socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection not open');
    }

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    const messageId = crypto.randomUUID();
    const output: string[] = [];

    return new Promise<string>((resolve, reject) => {
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

        this._socket.send(JSON.stringify({ messageId, containerId: this._currentContainerId, command }));
      } catch (error) {
        cleanup();
        clearTimeout(timeoutId);
        reject(new Error(`Failed to send command: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  // --- File/FS/utility methods ---

  async readFile(filePath: string): Promise<string> {
    await this.ensureContainerReady();

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    try {
      const content = await this.executeCommand(`cat "${filePath}"`);
      return content;
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.ensureContainerReady();

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    const dirname = path.substring(0, path.lastIndexOf('/'));
    await this.mkdir(dirname, { recursive: true });

    if (content instanceof Uint8Array) {
      const base64Content = Buffer.from(content).toString('base64');
      await this.executeCommand(`echo '${base64Content}' | base64 -d > "${path}"`);
    } else {
      await this.executeCommand(`printf '%s' '${this._escapeShellContent(content)}' > "${path}"`);
    }
  }

  async readDir(dirPath: string): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
    await this.ensureContainerReady();

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    try {
      const lsOutput = await this.executeCommand(`ls -la "${dirPath}" | awk '{print $1,$9}' | tail -n +2`);
      return lsOutput
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const [perms, name] = line.split(' ');
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

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    const cmd = options.recursive ? `mkdir -p "${path}"` : `mkdir "${path}"`;
    await this.executeCommand(cmd);
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.ensureContainerReady();

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

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

  async createFolder(folderPath: string, options: { recursive?: boolean } = {}): Promise<boolean> {
    try {
      await this.mkdir(folderPath, options);
      return true;
    } catch (error) {
      console.error(`Error creating directory ${folderPath}:`, error);
      return false;
    }
  }

  async uploadFiles(files: { path: string; content: string }[]): Promise<IFileTransferResponse> {
    await this.ensureContainerReady();

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    const response = await fetch(`${this._baseUrl}/api/files/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ containerId: this._currentContainerId, files }),
    });

    if (!response.ok) {
      let errorMessage = `HTTP error! status: ${response.status}`;

      try {
        const errorData = await response.json();
        errorMessage =
          typeof errorData === 'object' && errorData !== null && 'message' in errorData
            ? String(errorData.message)
            : errorMessage;
      } catch {}
      throw new Error(errorMessage);
    }

    const data: unknown = await response.json();

    function isFileTransferResponse(obj: unknown): obj is IFileTransferResponse {
      return (
        typeof obj === 'object' &&
        obj !== null &&
        'status' in obj &&
        (obj.status === 'success' || obj.status === 'failed')
      );
    }

    if (!isFileTransferResponse(data)) {
      throw new Error('Invalid file transfer response format');
    }

    return {
      status: data.status,
      message: 'message' in data && typeof data.message === 'string' ? data.message : undefined,
    };
  }

  async downloadFile(path: string): Promise<string> {
    await this.ensureContainerReady();

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    const response = await fetch(`${this._baseUrl}/api/files/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ containerId: this._currentContainerId, path }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.text();
  }

  // --- Watcher ---

  async watchPaths(options: WatchOptions, callback: (events: FileEvent[]) => void): Promise<{ close: () => void }> {
    await this.ensureContainerReady();
    await this.connect();

    const watchId = crypto.randomUUID();
    const pollInterval = options.pollInterval || 1000;
    const includePatterns = options.include.map((p) => p.replace(`${WORK_DIR}/`, '/app/'));
    const excludePatterns = options.exclude || ['**/node_modules/**', '**/.git/**'];

    let isWatching = true;
    let lastSnapshot: Record<string, { mtime: number; content?: string }> = {};

    const poll = async () => {
      if (!isWatching) {
        return;
      }

      try {
        if (!this.isConnected) {
          await this.connect();
        }

        const findCmd = [
          'find /app',
          ...includePatterns.map((p) => `-path "${p}"`),
          ...excludePatterns.map((p) => `! -path "${p}"`),
          '-type f',
          '-printf "%T@ %p\\n"',
        ].join(' ');

        const output = await this.executeCommand(findCmd);
        const currentFiles: Record<string, { mtime: number; content?: string }> = {};

        for (const line of output.split('\n').filter(Boolean)) {
          const [mtimeStr, filePath] = line.split(' ');
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
      } finally {
        if (isWatching) {
          setTimeout(poll, pollInterval);
        }
      }
    };
    poll();
    this._watchers.set(watchId, {
      close: () => {
        isWatching = false;
        this._watchers.delete(watchId);
      },
    });

    return {
      close: () => {
        isWatching = false;
        this._watchers.delete(watchId);
      },
    };
  }

  // --- Exec streaming (unchanged) ---

  async createExec(options: ExecOptions): Promise<string> {
    await this.ensureContainerReady();

    const response = await fetch(`${this._baseUrl}/api/exec/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    const data = (await response.json()) as ExecCreateResponse;

    return data.execId;
  }

  async startExec(execId: string): Promise<ExecStreams> {
    if (!execId || typeof execId !== 'string') {
      throw new Error('Invalid execId provided');
    }

    const wsUrl = `${this._baseUrl.replace('http', 'ws')}/api/exec/start?execId=${encodeURIComponent(execId)}`;
    const socket = new WebSocket(wsUrl);
    let cleanup: () => void;
    const cleanupOnce = () => {
      if (cleanup) {
        cleanup();

        cleanup = () => {};
      }
    };

    try {
      const socketConnected = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timed out'));
          socket.close();
        }, 5000);

        cleanup = () => {
          clearTimeout(timeout);
          socket.close();
        };

        socket.onopen = () => {
          clearTimeout(timeout);
          resolve(true);
        };

        socket.onerror = (error) => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket error: ${error instanceof Error ? error.message : 'Unknown error'}`));
        };
      });
      await socketConnected;

      const input = new WritableStream({
        write(chunk) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(chunk);
          } else {
            throw new Error('WebSocket connection is not open');
          }
        },
        close() {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close();
          }
        },
        abort(err) {
          console.error('WritableStream aborted:', err);
          socket.close();
        },
      });
      const output = new ReadableStream({
        start(controller) {
          socket.onmessage = (event) => {
            try {
              if (typeof event.data === 'string') {
                controller.enqueue(event.data);
              } else {
                console.warn('Received non-string WebSocket message');
              }
            } catch (error) {
              console.error('Error handling WebSocket message:', error);
              controller.error(error);
            }
          };

          socket.onclose = () => {
            controller.close();
          };

          socket.onerror = (error) => {
            controller.error(new Error(`WebSocket error: ${error instanceof Error ? error.message : 'Unknown error'}`));
          };
        },
        cancel() {
          socket.close();
        },
      });

      cleanup = () => {};

      return { input, output };
    } catch (error) {
      cleanupOnce();
      console.error('Failed to start exec:', error);
      throw new Error(`Failed to start exec: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async resizeExec(execId: string, cols: number, rows: number): Promise<void> {
    await fetch(`${this._baseUrl}/api/exec/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ execId, cols, rows }),
    });
  }

  async killExec(execId: string): Promise<void> {
    await fetch(`${this._baseUrl}/api/exec/kill?execId=${execId}`, { method: 'POST' });
  }

  async executeCommandStreaming(command: string, callback: (output: string) => void): Promise<void> {
    await this.ensureContainerReady();

    if (!this._socket) {
      throw new Error('WebSocket connection not initialized');
    }

    if (this._socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection not open');
    }

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    const messageId = crypto.randomUUID();
    let isComplete = false;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this._removeMessageHandler(messageId);
        isComplete = true;
      };
      const handler = (response: ICommandResponse) => {
        if (isComplete) {
          return;
        }

        try {
          switch (response.type) {
            case 'output':
              callback(response.data);
              break;
            case 'error':
              cleanup();
              reject(new Error(response.data));
              break;
            case 'end':
              cleanup();
              resolve();
              break;
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      this._addMessageHandler(messageId, handler);

      try {
        if (!this._socket) {
          throw new Error('WebSocket connection lost before sending command');
        }

        this._socket.send(
          JSON.stringify({ messageId, containerId: this._currentContainerId, command, streaming: true }),
        );

        const timeout = setTimeout(() => {
          if (!isComplete) {
            cleanup();
            reject(new Error('Command streaming timed out (no response)'));
          }
        }, 30000);
        Promise.race([
          new Promise((_, rej) => setTimeout(rej, 30000)),
          new Promise((res) => this._socket?.addEventListener('close', res)),
        ]).finally(() => clearTimeout(timeout));
      } catch (error) {
        cleanup();
        reject(new Error(`Failed to send command: ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
    });
  }

  // --- Port monitoring ---

  private async _monitorContainerPorts(containerId: string): Promise<void> {
    while (this._currentContainerId === containerId) {
      try {
        const status = await this.getContainerStatus();

        if (status.ports) {
          Object.entries(status.ports).forEach(([, hostPort]) => {
            const portNum = parseInt(hostPort, 10);

            if (!isNaN(portNum)) {
              this.emit('port', { type: 'open', port: portNum, url: `http://localhost:${portNum}` });
            }
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error('Port monitoring error:', error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  async startPortMonitoring(containerId: string): Promise<void> {
    return this._monitorContainerPorts(containerId);
  }

  // --- Container status ---

  private _isContainerStatus(response: unknown): response is IContainerStatus {
    return typeof response === 'object' && response !== null && 'containerId' in response && 'status' in response;
  }

  async getContainerStatus(): Promise<IContainerStatus> {
    await this.ensureContainerReady();

    if (!this._currentContainerId) {
      throw new Error('No active container session');
    }

    const response = await fetch(`${this._baseUrl}/api/containers/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ containerId: this._currentContainerId }),
    });
    const data: unknown = await response.json();

    if (!this._isContainerStatus(data)) {
      throw new Error('Invalid response format from server');
    }

    if (data.ports) {
      const ports: { [key: string]: string } = {};

      for (const [internalPort, hostPort] of Object.entries(data.ports)) {
        ports[internalPort] = hostPort;
      }
      data.ports = ports;
    }

    return data;
  }

  // --- Misc ---

  disconnect(): void {
    this._disconnect();
    this._currentContainerId = null;
  }

  private _disconnect(): void {
    if (!this._socket) {
      return;
    }

    try {
      if (this._socket.readyState === WebSocket.OPEN || this._socket.readyState === WebSocket.CONNECTING) {
        this._socket.close();
      }
    } catch (error) {
      console.error('Error closing WebSocket:', error);
    } finally {
      this._socket = null;
      this._messageHandlers.clear();
    }
  }

  private _addMessageHandler(messageId: string, handler: (data: ICommandResponse) => void): void {
    this._messageHandlers.set(messageId, handler);
  }

  private _removeMessageHandler(messageId: string): void {
    this._messageHandlers.delete(messageId);
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

  async stopContainer(): Promise<void> {
    if (!this._currentContainerId) {
      return;
    }

    const response = await fetch(`${this._baseUrl}/api/containers/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ containerId: this._currentContainerId }),
    });

    if (!response.ok) {
      throw new Error(`Failed to stop container: ${response.statusText}`);
    }

    this._currentContainerId = null;
  }
}

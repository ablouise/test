import { DockerClient } from '~/lib/dockerclient/docker-client';
import type { ITerminal } from '~/types/terminal';
import { withResolvers } from './promises';
import { atom } from 'nanostores';
import { expoUrlAtom } from '~/lib/stores/qrCodeStore';

export async function newShellProcess(
  dockerClient: DockerClient,
  terminal: ITerminal,
  command = '/bin/sh',
  args: string[] = [],
) {
  if (!dockerClient.currentContainerId) {
    throw new Error('No active container session');
  }

  // Create an exec instance in the container
  const execId = await dockerClient.createExec({
    containerId: dockerClient.currentContainerId,
    command: [command, ...args],
    interactive: true,
    tty: true,
    cols: terminal.cols ?? 80,
    rows: terminal.rows ?? 15,
  });

  // Start the exec instance and get streams
  const { input, output } = await dockerClient.startExec(execId);
  const inputWriter = input.getWriter(); // Get the writer from the WritableStream

  const jshReady = withResolvers<void>();
  let isInteractive = false;

  const writer = new WritableStream({
    write(data) {
      if (!isInteractive) {
        // Detect our custom interactive marker
        if (data.includes('BOLT_SHELL_READY')) {
          isInteractive = true;
          jshReady.resolve();
        }
      }

      terminal.write(data);
    },
  });

  output.pipeTo(writer).catch((err) => {
    console.error('Error piping output:', err);
  });

  terminal.onData((data) => {
    if (isInteractive) {
      inputWriter.write(data);
    }
  });

  await jshReady.promise;

  return {
    input,
    output,
    resize: async (cols: number, rows: number) => {
      await dockerClient.resizeExec(execId, cols, rows);
    },
  };
}

export type ExecutionResult = { output: string; exitCode: number } | undefined;

export class BoltShell {
  #initialized: (() => void) | undefined;
  #readyPromise: Promise<void>;
  #dockerClient: DockerClient | undefined;
  #terminal: ITerminal | undefined;
  #process: { input: WritableStream<string>; output: ReadableStream<string> } | undefined;
  executionState = atom<
    { sessionId: string; active: boolean; executionPrms?: Promise<any>; abort?: () => void } | undefined
  >();
  #outputStream: ReadableStreamDefaultReader<string> | undefined;
  #shellInputStream: WritableStreamDefaultWriter<string> | undefined;

  constructor() {
    this.#readyPromise = new Promise((resolve) => {
      this.#initialized = resolve;
    });
  }

  ready() {
    return this.#readyPromise;
  }

  async init(dockerClient: DockerClient, terminal: ITerminal) {
    this.#dockerClient = dockerClient;
    this.#terminal = terminal;

    const { process, commandStream, expoUrlStream } = await this.newBoltShellProcess(dockerClient, terminal);
    this.#process = process;
    this.#outputStream = commandStream.getReader();

    this._watchExpoUrlInBackground(expoUrlStream);
    await this.waitTillReady();
    this.#initialized?.();
  }

  async newBoltShellProcess(dockerClient: DockerClient, terminal: ITerminal) {
    if (!dockerClient.currentContainerId) {
      throw new Error('No container available');
    }

    // Start shell with our custom ready marker
    const execId = await dockerClient.createExec({
      containerId: dockerClient.currentContainerId,
      command: ['/bin/sh', '-c', 'echo "BOLT_SHELL_READY" && /bin/jsh --osc'],
      interactive: true,
      tty: true,
      cols: terminal.cols ?? 80,
      rows: terminal.rows ?? 15,
    });

    const { input, output } = await dockerClient.startExec(execId);
    const inputWriter = input.getWriter();
    this.#shellInputStream = inputWriter;

    // Create tee'd streams for multiple consumers
    const [streamA, streamB] = output.tee();
    const [streamC, streamD] = streamB.tee();

    const jshReady = withResolvers<void>();
    let isInteractive = false;

    streamA.pipeTo(
      new WritableStream({
        write(data) {
          if (!isInteractive) {
            if (data.includes('BOLT_SHELL_READY')) {
              isInteractive = true;
              jshReady.resolve();
            }
          }

          terminal.write(data);
        },
      }),
    );

    terminal.onData((data) => {
      if (isInteractive) {
        inputWriter.write(data);
      }
    });

    await jshReady.promise;

    return {
      process: { input, output },
      terminalStream: streamA,
      commandStream: streamC,
      expoUrlStream: streamD,
    };
  }

  private async _watchExpoUrlInBackground(stream: ReadableStream<string>) {
    const reader = stream.getReader();
    let buffer = '';
    const expoUrlRegex = /(exp:\/\/[^\s]+)/;

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += value || '';

      const expoUrlMatch = buffer.match(expoUrlRegex);

      if (expoUrlMatch) {
        const cleanUrl = expoUrlMatch[1]
          .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
          .replace(/[^\x20-\x7E]+$/g, '');
        expoUrlAtom.set(cleanUrl);
        buffer = buffer.slice(buffer.indexOf(expoUrlMatch[1]) + expoUrlMatch[1].length);
      }

      if (buffer.length > 2048) {
        buffer = buffer.slice(-2048);
      }
    }
  }

  get terminal() {
    return this.#terminal;
  }

  get process() {
    return this.#process;
  }

  async executeCommand(sessionId: string, command: string, abort?: () => void): Promise<ExecutionResult> {
    if (!this.process || !this.terminal) {
      return undefined;
    }

    const state = this.executionState.get();

    if (state?.active && state.abort) {
      state.abort();
    }

    this.terminal.input('\x03');
    await this.waitTillPrompt();

    if (state && state.executionPrms) {
      await state.executionPrms;
    }

    this.terminal.input(command.trim() + '\n');

    const executionPromise = this.getCurrentExecutionResult();
    this.executionState.set({ sessionId, active: true, executionPrms: executionPromise, abort });

    const resp = await executionPromise;
    this.executionState.set({ sessionId, active: false });

    if (resp) {
      try {
        resp.output = cleanTerminalOutput(resp.output);
      } catch (error) {
        console.log('failed to format terminal output', error);
      }
    }

    return resp;
  }

  async getCurrentExecutionResult(): Promise<ExecutionResult> {
    const { output, exitCode } = await this.waitTillExit();
    return { output, exitCode };
  }

  async waitTillReady() {
    await this._waitForMarker('BOLT_SHELL_READY');
  }

  async waitTillPrompt() {
    await this._waitForMarker('❯');
  }

  async waitTillExit() {
    let output = '';

    while (true) {
      const chunk = await this._readNextChunk();
      output += chunk;

      if (chunk.includes('exit')) {
        return { output, exitCode: 0 };
      }
    }
  }

  private async _waitForMarker(marker: string) {
    while (true) {
      const chunk = await this._readNextChunk();

      if (chunk.includes(marker)) {
        return;
      }
    }
  }

  private async _readNextChunk(): Promise<string> {
    if (!this.#outputStream) {
      return '';
    }

    const { value } = await this.#outputStream.read();

    return value || '';
  }
}

/**
 * Cleans and formats terminal output while preserving structure and paths
 * Handles ANSI, OSC, and various terminal control sequences
 */
export function cleanTerminalOutput(input: string): string {
  // Step 1: Remove OSC sequences (including those with parameters)
  const removeOsc = input
    .replace(/\x1b\](\d+;[^\x07\x1b]*|\d+[^\x07\x1b]*)\x07/g, '')
    .replace(/\](\d+;[^\n]*|\d+[^\n]*)/g, '');

  // Step 2: Remove ANSI escape sequences and color codes more thoroughly
  const removeAnsi = removeOsc
    // Remove all escape sequences with parameters
    .replace(/\u001b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    // Remove color codes
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    // Clean up any remaining escape characters
    .replace(/\u001b/g, '')
    .replace(/\x1b/g, '');

  // Step 3: Clean up carriage returns and newlines
  const cleanNewlines = removeAnsi
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  // Step 4: Add newlines at key breakpoints while preserving paths
  const formatOutput = cleanNewlines
    // Preserve prompt line
    .replace(/^([~\/][^\n❯]+)❯/m, '$1\n❯')
    // Add newline before command output indicators
    .replace(/(?<!^|\n)>/g, '\n>')
    // Add newline before error keywords without breaking paths
    .replace(/(?<!^|\n|\w)(error|failed|warning|Error|Failed|Warning):/g, '\n$1:')
    // Add newline before 'at' in stack traces without breaking paths
    .replace(/(?<!^|\n|\/)(at\s+(?!async|sync))/g, '\nat ')
    // Ensure 'at async' stays on same line
    .replace(/\bat\s+async/g, 'at async')
    // Add newline before npm error indicators
    .replace(/(?<!^|\n)(npm ERR!)/g, '\n$1');

  // Step 5: Clean up whitespace while preserving intentional spacing
  const cleanSpaces = formatOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  // Step 6: Final cleanup
  return cleanSpaces
    .replace(/\n{3,}/g, '\n\n') // Replace multiple newlines with double newlines
    .replace(/:\s+/g, ': ') // Normalize spacing after colons
    .replace(/\s{2,}/g, ' ') // Remove multiple spaces
    .replace(/^\s+|\s+$/g, '') // Trim start and end
    .replace(/\u0000/g, ''); // Remove null characters
}

export function newBoltShellProcess() {
  return new BoltShell();
}

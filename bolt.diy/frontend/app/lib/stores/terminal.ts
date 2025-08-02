import { atom, type WritableAtom } from 'nanostores';
import type { ITerminal } from '~/types/terminal';
import { newBoltShellProcess, newShellProcess } from '~/utils/shell';
import { coloredText } from '~/utils/terminal';
import { DockerClient } from '~/lib/dockerclient/docker-client';

export class TerminalStore {
  #dockerClient: DockerClient;
  #terminals: Array<{
    terminal: ITerminal;
    process: {
      resize: (cols: number, rows: number) => Promise<void>;
    };
  }> = [];
  #boltTerminal = newBoltShellProcess();
  #initialized = false;

  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(true);

  constructor(dockerClient: DockerClient) {
    this.#dockerClient = dockerClient;

    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }

  get boltTerminal() {
    return this.#boltTerminal;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    
    // Initialize any terminal resources here
    try {
      // Example: Pre-warm terminal connections if needed
      // await this.#preconnectTerminals();
      
      this.#initialized = true;
      console.log('TerminalStore initialized');
    } catch (error) {
      console.error('Terminal initialization failed:', error);
      throw error;
    }
  }

  cleanup(): void {
    this.#terminals = [];
    // Add any other cleanup logic needed
    this.#initialized = false;
  }

  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }

  async attachBoltTerminal(terminal: ITerminal) {
    try {
      const wc = await this.#dockerClient;
      await this.#boltTerminal.init(wc, terminal);
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to spawn bolt shell\n\n') + error.message);
      return;
    }
  }

  async attachTerminal(terminal: ITerminal) {
    try {
      const shellProcess = await newShellProcess(await this.#dockerClient, terminal);
      this.#terminals.push({ terminal, process: shellProcess });
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to spawn shell\n\n') + error.message);
      return;
    }
  }

  async onTerminalResize(cols: number, rows: number) {
    for (const { process } of this.#terminals) {
      try {
        await process.resize(cols, rows);
      } catch (error) {
        console.error('Failed to resize terminal:', error);
      }
    }
  }

  async detachTerminal(terminal: ITerminal) {
    const terminalIndex = this.#terminals.findIndex((t) => t.terminal === terminal);

    if (terminalIndex !== -1) {
      this.#terminals.splice(terminalIndex, 1);
    }
  }
}
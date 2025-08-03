import { DockerClient } from './docker-client';

// Only create client in browser - NEVER on server
let dockerClientInstance: DockerClient | null = null;

if (typeof window !== 'undefined') {
  try {
    dockerClientInstance = new DockerClient();
  } catch (error) {
    console.warn('Failed to initialize DockerClient:', error);
    dockerClientInstance = null;
  }
}

export const dockerClient = dockerClientInstance;

// Export types
export { DockerClient };
export type { FileEvent, ICommandResponse, IStartProjectResponse, WatchOptions } from './docker-client';

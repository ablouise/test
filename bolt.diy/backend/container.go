package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
)

type ContainerManager struct {
	cli          *client.Client
	readyStates  sync.Map
	mu           sync.Mutex
	projectLocks sync.Map
}

func (m *ContainerManager) getProjectLock(projectID string) *sync.Mutex {
	lock, _ := m.projectLocks.LoadOrStore(projectID, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func NewContainerManager() (*ContainerManager, error) {
	log.Println("Initializing Docker client...")

	connectionAttempts := []struct {
		host string
		opts []client.Opt
	}{
		// 1. First try environment variables (DOCKER_HOST)
		{
			host: "from environment",
			opts: []client.Opt{client.FromEnv, client.WithAPIVersionNegotiation()},
		},
		// 2. Try standard Unix socket paths
		{
			host: "unix:///var/run/docker.sock",
			opts: []client.Opt{
				client.WithHost("unix:///var/run/docker.sock"),
				client.WithAPIVersionNegotiation(),
			},
		},
		// 3. Try Colima's default socket
		{
			host: "colima default",
			opts: []client.Opt{
				client.WithHost("unix://" + filepath.Join(os.Getenv("HOME"), ".colima", "default", "docker.sock")),
				client.WithAPIVersionNegotiation(),
			},
		},
		// 4. Try Docker Desktop for Mac
		{
			host: "docker desktop",
			opts: []client.Opt{
				client.WithHost("unix:///Users/" + os.Getenv("USER") + "/Library/Containers/com.docker.docker/Data/docker.sock"),
				client.WithAPIVersionNegotiation(),
			},
		},
	}

	var lastErr error
	var cli *client.Client

	for _, attempt := range connectionAttempts {
		log.Printf("Attempting to connect to Docker via %s...", attempt.host)

		cli, lastErr = client.NewClientWithOpts(attempt.opts...)
		if lastErr != nil {
			log.Printf("Connection attempt failed (%s): %v", attempt.host, lastErr)
			continue
		}

		// Verify the connection works
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		log.Printf("Verifying Docker connection via %s...", attempt.host)
		if _, err := cli.Ping(ctx); err != nil {
			lastErr = fmt.Errorf("ping failed: %w", err)
			log.Printf("Ping verification failed (%s): %v", attempt.host, err)
			continue
		}

		log.Printf("Successfully connected to Docker via %s", attempt.host)
		return &ContainerManager{
			cli:         cli,
			readyStates: sync.Map{},
		}, nil
	}

	log.Printf("All Docker connection attempts failed. Last error: %v", lastErr)
	return nil, fmt.Errorf("failed to connect to Docker after trying all options. Last error: %w", lastErr)
}

func (m *ContainerManager) CreateAndStart(projectID string) (*StartProjectResponse, error) {
	ctx := context.Background()

	log.Printf("[CreateAndStart] Step 1: Resolving absolute project path for %q", projectID)
	projectPath, err := filepath.Abs(filepath.Join("projects", projectID))
	if err != nil {
		log.Printf("[CreateAndStart] Error: failed to get absolute path: %v", err)
		return nil, fmt.Errorf("failed to get absolute path: %w", err)
	}

	log.Printf("[CreateAndStart] Step 2: Ensuring project directory exists at %q", projectPath)
	if err := os.MkdirAll(projectPath, 0755); err != nil {
		log.Printf("[CreateAndStart] Error: failed to create project directory: %v", err)
		return nil, fmt.Errorf("failed to create project directory: %w", err)
	}

	log.Printf("[CreateAndStart] Step 3: Cleaning up any existing container for %q", projectID)
	if err := m.cleanupExisting(ctx, projectID); err != nil {
		log.Printf("[CreateAndStart] Error: cleanup failed: %v", err)
		return nil, fmt.Errorf("cleanup failed: %w", err)
	}

	log.Printf("[CreateAndStart] Step 4: Creating container for %q", projectID)
	resp, err := m.cli.ContainerCreate(
		ctx,
		&container.Config{
			Image:      "node:20-alpine",
			Tty:        true,
			WorkingDir: "/app",
			OpenStdin:  true,
			Cmd:        []string{"tail", "-f", "/dev/null"},
			Healthcheck: &container.HealthConfig{
				Test:     []string{"CMD-SHELL", "command -v node && echo OK"},
				Interval: 5 * time.Second,
				Timeout:  3 * time.Second,
				Retries:  3,
			},
		},
		&container.HostConfig{
			Mounts: []mount.Mount{
				{
					Type:   mount.TypeBind,
					Source: projectPath,
					Target: "/app",
				},
			},
			PortBindings: nat.PortMap{
				"3000/tcp": []nat.PortBinding{{HostPort: ""}},
			},
			AutoRemove: false,
		},
		nil,
		nil,
		fmt.Sprintf("bolt-%s", projectID),
	)
	if err != nil {
		log.Printf("[CreateAndStart] Error: container create failed: %v", err)
		return nil, fmt.Errorf("container create failed: %w", err)
	}
	log.Printf("[CreateAndStart] Step 4b: Container created with ID %s", resp.ID)

	log.Printf("[CreateAndStart] Step 5: Starting container %s", resp.ID)
	if err := m.cli.ContainerStart(ctx, resp.ID, types.ContainerStartOptions{}); err != nil {
		log.Printf("[CreateAndStart] Error: container start failed: %v", err)
		return nil, fmt.Errorf("container start failed: %w", err)
	}
	log.Printf("[CreateAndStart] Step 5b: Container started")

	log.Printf("[CreateAndStart] Step 6: Waiting for container to be healthy (ID: %s)", resp.ID)
	if err := m.waitForHealthy(ctx, resp.ID); err != nil {
		log.Printf("[CreateAndStart] Error: container not healthy: %v", err)
		return nil, fmt.Errorf("container not healthy: %w", err)
	}
	log.Printf("[CreateAndStart] Step 6b: Container is healthy")

	log.Printf("[CreateAndStart] Step 7: Verifying command execution in container %s", resp.ID)
	if err := m.verifyCommandExecution(ctx, resp.ID); err != nil {
		log.Printf("[CreateAndStart] Error: container command execution failed: %v", err)
		return nil, fmt.Errorf("container command execution failed: %w", err)
	}
	log.Printf("[CreateAndStart] Step 7b: Command execution verified")

	log.Printf("[CreateAndStart] Step 8: Getting port mappings for container %s", resp.ID)
	ports, err := m.getPortMappings(ctx, resp.ID)
	if err != nil {
		log.Printf("[CreateAndStart] Error: failed to get ports: %v", err)
		return nil, fmt.Errorf("failed to get ports: %w", err)
	}
	log.Printf("[CreateAndStart] Step 8b: Ports mapped: %+v", ports)

	log.Printf("[CreateAndStart] Step 9: Returning StartProjectResponse for container %s", resp.ID)
	m.SetContainerReady(resp.ID)
	return &StartProjectResponse{
		ContainerID: resp.ID,
		Status:      "success",
		Ports:       ports,
	}, nil
}

func (m *ContainerManager) WaitForContainerReady(ctx context.Context, containerID string) error {
	// Check if already ready
	if _, ok := m.readyStates.Load(containerID); ok {
		return nil
	}

	// Create a new ready channel
	ready := make(chan struct{})
	actual, loaded := m.readyStates.LoadOrStore(containerID, ready)
	if loaded {
		close(ready)
		ready = actual.(chan struct{})
	}

	select {
	case <-ready:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *ContainerManager) executeCommand(ctx context.Context, containerID string, command string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	log.Printf("Executing command in container %s: %s", containerID, command)

	if m.cli == nil {
		err := fmt.Errorf("Docker client not initialized")
		log.Printf("Error: %v", err)
		return "", err
	}

	// Verify container exists first
	log.Printf("Inspecting container %s...", containerID)
	_, err := m.cli.ContainerInspect(ctx, containerID)
	if err != nil {
		err = fmt.Errorf("container inspection failed: %w", err)
		log.Printf("Error: %v", err)
		return "", err
	}

	// Create exec configuration
	log.Printf("Creating exec instance in container %s...", containerID)
	execConfig := types.ExecConfig{
		Cmd:          []string{"sh", "-c", command},
		AttachStdout: true,
		AttachStderr: true,
	}

	// Create exec instance
	execID, err := m.cli.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		err = fmt.Errorf("exec creation failed: %w", err)
		log.Printf("Error: %v", err)
		return "", err
	}
	log.Printf("Created exec instance %s in container %s", execID.ID, containerID)

	// Attach to exec instance
	log.Printf("Attaching to exec instance %s...", execID.ID)
	resp, err := m.cli.ContainerExecAttach(ctx, execID.ID, types.ExecStartCheck{})
	if err != nil {
		err = fmt.Errorf("exec attach failed: %w", err)
		log.Printf("Error: %v", err)
		return "", err
	}
	defer resp.Close()
	log.Printf("Successfully attached to exec instance %s", execID.ID)

	// Read output with timeout
	log.Printf("Reading command output from container %s...", containerID)
	output := make(chan string, 1)
	errChan := make(chan error, 1)

	go func() {
		buf := new(strings.Builder)
		_, err := io.Copy(buf, resp.Reader)
		if err != nil {
			log.Printf("Error reading command output: %v", err)
			errChan <- err
			return
		}
		output <- buf.String()
	}()

	select {
	case <-ctx.Done():
		log.Printf("Command execution cancelled: %v", ctx.Err())
		return "", ctx.Err()
	case err := <-errChan:
		log.Printf("Error during command execution: %v", err)
		return "", fmt.Errorf("output read failed: %w", err)
	case out := <-output:
		log.Printf("Command executed successfully in container %s", containerID)
		log.Printf("Command output length: %d bytes", len(out))
		return out, nil
	case <-time.After(30 * time.Second):
		log.Printf("Command execution timed out after 30 seconds")
		return "", fmt.Errorf("command execution timed out")
	}
}

func (m *ContainerManager) verifyCommandExecution(ctx context.Context, containerID string) error {
	log.Printf("[verifyCommandExecution] Inspecting container %s", containerID)
	_, err := m.cli.ContainerInspect(ctx, containerID)
	if err != nil {
		log.Printf("[verifyCommandExecution] Inspection failed: %v", err)
		return fmt.Errorf("container inspection failed: %w", err)
	}

	log.Printf("[verifyCommandExecution] Executing 'echo ready' in %s", containerID)
	out, err := m.executeCommand(ctx, containerID, "echo ready")
	log.Printf("[verifyCommandExecution] Exec returned (err: %v), output: %q", err, out)
	if err != nil {
		return err
	}
	if !strings.Contains(out, "ready") {
		return fmt.Errorf("container not responding properly")
	}
	return nil
}

func (m *ContainerManager) SetContainerReady(containerID string) {
	if actual, loaded := m.readyStates.LoadAndDelete(containerID); loaded {
		close(actual.(chan struct{}))
	}
}

func (m *ContainerManager) waitForHealthy(ctx context.Context, containerID string) error {
	const timeout = 60 * time.Second // Increased timeout
	const interval = 1 * time.Second // More reasonable check interval

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// First check if basic services are up
	if err := m.waitForBasicReadiness(ctx, containerID); err != nil {
		return err
	}

	// Then verify application-specific readiness
	return m.waitForApplicationReady(ctx, containerID)
}

func (m *ContainerManager) ExecuteCommandWS(containerID, command string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Wait for container to be ready first
	if err := m.WaitForContainerReady(ctx, containerID); err != nil {
		return "", fmt.Errorf("container not ready: %w", err)
	}

	return m.executeCommand(ctx, containerID, command)
}

func (m *ContainerManager) waitForBasicReadiness(ctx context.Context, containerID string) error {
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("timeout waiting for container to start: %w", ctx.Err())
		case <-time.After(500 * time.Millisecond):
			inspect, err := m.cli.ContainerInspect(ctx, containerID)
			if err != nil {
				return fmt.Errorf("inspection error: %w", err)
			}

			// Check container state
			if inspect.State == nil {
				continue
			}

			if inspect.State.Status == "exited" {
				return fmt.Errorf("container exited with code %d", inspect.State.ExitCode)
			}

			if !inspect.State.Running {
				continue
			}

			// Check health status if healthcheck configured
			if inspect.State.Health != nil {
				switch inspect.State.Health.Status {
				case "healthy":
					return nil
				case "unhealthy":
					return fmt.Errorf("container is unhealthy")
				}
			}

			// If no healthcheck, consider running as ready
			return nil
		}
	}
}

func (m *ContainerManager) waitForApplicationReady(ctx context.Context, containerID string) error {
	// Try executing a simple command to verify actual readiness
	execID, err := m.cli.ContainerExecCreate(ctx, containerID, types.ExecConfig{
		Cmd:          []string{"sh", "-c", "command -v node && echo OK"},
		AttachStdout: true,
		AttachStderr: true,
	})
	if err != nil {
		return fmt.Errorf("exec create failed: %w", err)
	}

	resp, err := m.cli.ContainerExecAttach(ctx, execID.ID, types.ExecStartCheck{})
	if err != nil {
		return fmt.Errorf("exec attach failed: %w", err)
	}
	defer resp.Close()

	// Read output with timeout
	output := make(chan string, 1)
	go func() {
		buf := new(strings.Builder)
		_, err := io.Copy(buf, resp.Reader)
		if err != nil {
			return
		}
		output <- buf.String()
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case out := <-output:
		if !strings.Contains(out, "OK") {
			return fmt.Errorf("application not ready")
		}
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("timeout waiting for application response")
	}
}

func (m *ContainerManager) cleanupExisting(ctx context.Context, projectID string) error {
	containers, err := m.cli.ContainerList(ctx, types.ContainerListOptions{
		All: true,
		Filters: filters.NewArgs(
			filters.Arg("name", fmt.Sprintf("bolt-%s", projectID)),
		),
	})
	if err != nil {
		return fmt.Errorf("list containers failed: %w", err)
	}

	for _, c := range containers {
		if err := m.cli.ContainerRemove(ctx, c.ID, types.ContainerRemoveOptions{
			Force: true,
		}); err != nil {
			return fmt.Errorf("remove container failed: %w", err)
		}
	}
	return nil
}

func (m *ContainerManager) getPortMappings(ctx context.Context, containerID string) (map[string]string, error) {
	inspect, err := m.cli.ContainerInspect(ctx, containerID)
	if err != nil {
		return nil, fmt.Errorf("inspect failed: %w", err)
	}

	ports := make(map[string]string)
	for port, bindings := range inspect.NetworkSettings.Ports {
		if len(bindings) > 0 {
			ports[string(port)] = bindings[0].HostPort
		}
	}
	return ports, nil
}

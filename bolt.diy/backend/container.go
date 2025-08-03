package main

import (
	"context"
	"fmt"
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

// DockerClient is an alias for the Docker client
// This fixes the "undefined: DockerClient" error
type DockerClient = *client.Client

type ContainerManager struct {
	cli           DockerClient // Now properly typed
	containerInfo map[string]*ContainerInfo
	mu            sync.RWMutex
}

type ContainerInfo struct {
	ID     string
	Status string
	Ports  map[string]string
}

type StartProjectResponse struct {
	ContainerID string            `json:"containerId"`
	Status      string            `json:"status"`
	Message     string            `json:"message,omitempty"`
	Ports       map[string]string `json:"ports,omitempty"`
}

// NewContainerManager creates a new ContainerManager instance
// This fixes the "undefined: NewContainerManager" error
func NewContainerManager(cli DockerClient) *ContainerManager {
	return &ContainerManager{
		cli:           cli,
		containerInfo: make(map[string]*ContainerInfo),
	}
}

// executeCommand runs a command in the specified container
// This fixes the "executeCommand undefined" error
func (m *ContainerManager) executeCommand(ctx context.Context, containerID string, command string) (string, error) {
	// Create exec configuration
	execConfig := types.ExecConfig{
		Cmd:          []string{"/bin/sh", "-c", command},
		AttachStdout: true,
		AttachStderr: true,
	}

	// Create exec instance
	execResp, err := m.cli.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return "", fmt.Errorf("failed to create exec: %w", err)
	}

	// Attach to exec
	execAttach, err := m.cli.ContainerExecAttach(ctx, execResp.ID, types.ExecStartCheck{})
	if err != nil {
		return "", fmt.Errorf("failed to attach to exec: %w", err)
	}
	defer execAttach.Close()

	// Read output
	output := make([]byte, 1024)
	n, err := execAttach.Reader.Read(output)
	if err != nil && err.Error() != "EOF" {
		return "", fmt.Errorf("failed to read exec output: %w", err)
	}

	return string(output[:n]), nil
}

func (m *ContainerManager) CreateAndStart(projectID string) (*StartProjectResponse, error) {
	ctx := context.Background()

	log.Printf("[CreateAndStart] Checking for existing running container for project %s", projectID)

	// 1. Check for existing running container first (bolt.diy behavior)
	existingContainer, err := m.findRunningContainer(ctx, projectID)
	if err == nil && existingContainer != nil {
		log.Printf("[CreateAndStart] Found existing running container: %s", existingContainer.ID)

		// Verify it's actually working
		if err := m.verifyCommandExecution(ctx, existingContainer.ID); err == nil {
			log.Printf("[CreateAndStart] Reusing healthy container: %s", existingContainer.ID)
			ports, _ := m.getPortMappings(ctx, existingContainer.ID)
			m.SetContainerReady(existingContainer.ID)
			return &StartProjectResponse{
				ContainerID: existingContainer.ID,
				Status:      "success",
				Ports:       ports,
				Message:     "Reused existing container",
			}, nil
		} else {
			log.Printf("[CreateAndStart] Existing container unhealthy: %v", err)
		}
	}

	// 2. Get project path but DON'T create directory automatically
	projectPath, err := filepath.Abs(filepath.Join("projects", projectID))
	if err != nil {
		return nil, fmt.Errorf("failed to get absolute path: %w", err)
	}

	// 3. Only create directory if it doesn't exist (lazy creation)
	if _, err := os.Stat(projectPath); os.IsNotExist(err) {
		if err := os.MkdirAll(projectPath, 0755); err != nil {
			return nil, fmt.Errorf("failed to create project directory: %w", err)
		}
		log.Printf("Created project directory on demand: %s", projectPath)
	} else {
		log.Printf("Using existing project directory: %s", projectPath)
	}

	// 4. Cleanup only broken/stopped containers
	if err := m.cleanupBrokenContainers(ctx, projectID); err != nil {
		log.Printf("Warning: cleanup failed: %v", err)
	}

	// 5. Create new container
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
		return nil, fmt.Errorf("container create failed: %w", err)
	}

	// 6. Start container
	if err := m.cli.ContainerStart(ctx, resp.ID, types.ContainerStartOptions{}); err != nil {
		return nil, fmt.Errorf("container start failed: %w", err)
	}

	// 7. Wait for container to be healthy
	if err := m.waitForHealthy(ctx, resp.ID); err != nil {
		return nil, fmt.Errorf("container not healthy: %w", err)
	}

	// 8. Verify command execution
	if err := m.verifyCommandExecution(ctx, resp.ID); err != nil {
		return nil, fmt.Errorf("container command execution failed: %w", err)
	}

	ports, err := m.getPortMappings(ctx, resp.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to get ports: %w", err)
	}

	// ✅ NO automatic file creation - matches bolt.diy behavior
	log.Printf("Container ready - empty project preserved (bolt.diy behavior)")
	m.SetContainerReady(resp.ID)
	return &StartProjectResponse{
		ContainerID: resp.ID,
		Status:      "success",
		Ports:       ports,
		Message:     "Container ready - project starts empty like bolt.diy",
	}, nil
}

// Helper function to find existing running containers
func (m *ContainerManager) findRunningContainer(ctx context.Context, projectID string) (*types.Container, error) {
	containers, err := m.cli.ContainerList(ctx, types.ContainerListOptions{
		Filters: filters.NewArgs(
			filters.Arg("name", fmt.Sprintf("bolt-%s", projectID)),
			filters.Arg("status", "running"),
		),
	})
	if err != nil {
		return nil, err
	}

	if len(containers) > 0 {
		return &containers[0], nil
	}
	return nil, fmt.Errorf("no running container found")
}

// Helper function to cleanup broken containers only
func (m *ContainerManager) cleanupBrokenContainers(ctx context.Context, projectID string) error {
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
		// Only remove containers that are not running
		if c.State != "running" || strings.Contains(c.Status, "unhealthy") {
			log.Printf("Removing broken container: %s (status: %s)", c.ID, c.State)
			if err := m.cli.ContainerRemove(ctx, c.ID, types.ContainerRemoveOptions{
				Force: true,
			}); err != nil {
				log.Printf("Warning: failed to remove container %s: %v", c.ID, err)
			}
		}
	}
	return nil
}

func (m *ContainerManager) waitForHealthy(ctx context.Context, containerID string) error {
	timeout := 30 * time.Second
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		inspect, err := m.cli.ContainerInspect(ctx, containerID)
		if err != nil {
			return fmt.Errorf("failed to inspect container: %w", err)
		}

		if inspect.State.Health != nil {
			switch inspect.State.Health.Status {
			case "healthy":
				return nil
			case "unhealthy":
				return fmt.Errorf("container became unhealthy")
			}
		} else if inspect.State.Running {
			// No health check defined, just check if running
			return nil
		}

		time.Sleep(1 * time.Second)
	}

	return fmt.Errorf("container did not become healthy within %v", timeout)
}

func (m *ContainerManager) verifyCommandExecution(ctx context.Context, containerID string) error {
	execConfig := types.ExecConfig{
		Cmd:          []string{"echo", "test"},
		AttachStdout: true,
		AttachStderr: true,
	}

	execResp, err := m.cli.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return fmt.Errorf("failed to create exec: %w", err)
	}

	execAttach, err := m.cli.ContainerExecAttach(ctx, execResp.ID, types.ExecStartCheck{})
	if err != nil {
		return fmt.Errorf("failed to attach to exec: %w", err)
	}
	defer execAttach.Close()

	return nil
}

func (m *ContainerManager) getPortMappings(ctx context.Context, containerID string) (map[string]string, error) {
	inspect, err := m.cli.ContainerInspect(ctx, containerID)
	if err != nil {
		return nil, err
	}

	ports := make(map[string]string)
	for port, bindings := range inspect.NetworkSettings.Ports {
		if len(bindings) > 0 {
			ports[string(port)] = bindings[0].HostPort
		}
	}

	return ports, nil
}

func (m *ContainerManager) SetContainerReady(containerID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.containerInfo == nil {
		m.containerInfo = make(map[string]*ContainerInfo)
	}

	m.containerInfo[containerID] = &ContainerInfo{
		ID:     containerID,
		Status: "ready",
	}
}

package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
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
type DockerClient = *client.Client

type ContainerManager struct {
	cli           DockerClient
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

// createDockerClient creates a Docker client that works across platforms
// Automatically detects Colima, Docker Desktop, and standard Docker
func createDockerClient() (DockerClient, error) {
	var possibleHosts []string

	// Get user home directory
	homeDir, err := os.UserHomeDir()
	if err != nil {
		homeDir = os.Getenv("HOME") // fallback
	}

	if runtime.GOOS == "darwin" {
		// macOS - try common Docker socket locations in order
		possibleHosts = []string{
			"unix:///var/run/docker.sock",                                 // Standard Docker Desktop
			fmt.Sprintf("unix://%s/.colima/default/docker.sock", homeDir), // Colima default
			fmt.Sprintf("unix://%s/.colima/docker.sock", homeDir),         // Colima older versions
			fmt.Sprintf("unix://%s/.docker/run/docker.sock", homeDir),     // Docker Desktop user
			fmt.Sprintf("unix://%s/.docker/desktop/docker.sock", homeDir), // Docker Desktop alternative
		}
	} else if runtime.GOOS == "linux" {
		// Linux - try common locations
		possibleHosts = []string{
			"unix:///var/run/docker.sock",                                 // Standard Docker daemon
			fmt.Sprintf("unix://%s/.docker/desktop/docker.sock", homeDir), // Docker Desktop on Linux
		}
	} else if runtime.GOOS == "windows" {
		// Windows
		possibleHosts = []string{
			"npipe:////./pipe/docker_engine", // Standard Docker Desktop
		}
	}

	// Try each possible host until one works
	for _, host := range possibleHosts {
		log.Printf("Trying Docker host: %s", host)

		cli, err := client.NewClientWithOpts(
			client.WithHost(host),
			client.WithAPIVersionNegotiation(),
		)
		if err != nil {
			log.Printf("Failed to create client with host %s: %v", host, err)
			continue
		}

		// Test the connection with a longer timeout
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, err = cli.Ping(ctx)
		cancel()

		if err != nil {
			log.Printf("Failed to ping Docker daemon at %s: %v", host, err)
			cli.Close()
			continue
		}

		log.Printf("✅ Successfully connected to Docker daemon at: %s", host)
		return cli, nil
	}

	// If all specific hosts fail, try the default (FromEnv)
	log.Printf("All specific hosts failed, trying default Docker client")
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("failed to create Docker client: %w", err)
	}

	// Test the default connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, err = cli.Ping(ctx)
	cancel()

	if err != nil {
		cli.Close()
		return nil, fmt.Errorf("❌ Cannot connect to Docker daemon. Is Docker/Colima running? %w", err)
	}

	log.Printf("✅ Successfully connected using default Docker client")
	return cli, nil
}

// NewContainerManager creates a new ContainerManager instance with auto-detected Docker client
func NewContainerManager() (*ContainerManager, error) {
	cli, err := createDockerClient()
	if err != nil {
		return nil, err
	}

	log.Printf("🐳 Docker client initialized successfully on %s", runtime.GOOS)

	return &ContainerManager{
		cli:           cli,
		containerInfo: make(map[string]*ContainerInfo),
	}, nil
}

func (m *ContainerManager) executeCommand(ctx context.Context, containerID string, command string) (string, error) {
	log.Printf("🚀 Executing in container %s: %s", containerID[:12], command)

	// ✅ Fixed: Ensure command is executed as a single shell command
	execConfig := types.ExecConfig{
		Cmd:          []string{"/bin/sh", "-c", command}, // This is correct
		AttachStdout: true,
		AttachStderr: true,
	}

	execResp, err := m.cli.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return "", fmt.Errorf("failed to create exec: %w", err)
	}

	execAttach, err := m.cli.ContainerExecAttach(ctx, execResp.ID, types.ExecStartCheck{})
	if err != nil {
		return "", fmt.Errorf("failed to attach to exec: %w", err)
	}
	defer execAttach.Close()

	output, err := io.ReadAll(execAttach.Reader)
	if err != nil {
		return "", fmt.Errorf("failed to read exec output: %w", err)
	}

	return string(output), nil
}

func (m *ContainerManager) CreateAndStart(projectID string) (*StartProjectResponse, error) {
	ctx := context.Background()

	log.Printf("🚀 [CreateAndStart] Starting project %s on %s", projectID, runtime.GOOS)

	// 1. Check for existing running container
	existingContainer, err := m.findRunningContainer(ctx, projectID)
	if err == nil && existingContainer != nil {
		log.Printf("🔄 [CreateAndStart] Found existing container: %s", existingContainer.ID[:12])

		if err := m.verifyCommandExecution(ctx, existingContainer.ID); err == nil {
			log.Printf("✅ [CreateAndStart] Reusing healthy container: %s", existingContainer.ID[:12])
			ports, _ := m.getPortMappings(ctx, existingContainer.ID)
			m.SetContainerReady(existingContainer.ID)
			return &StartProjectResponse{
				ContainerID: existingContainer.ID,
				Status:      "success",
				Ports:       ports,
				Message:     "Reused existing container",
			}, nil
		} else {
			log.Printf("⚠️ [CreateAndStart] Existing container unhealthy: %v", err)
		}
	}

	// 2. Cross-platform project path handling
	projectPath, err := m.getProjectPath(projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to get project path: %w", err)
	}

	// 3. Create directory with proper permissions for all platforms
	if err := m.ensureProjectDirectory(projectPath); err != nil {
		return nil, fmt.Errorf("failed to ensure project directory: %w", err)
	}

	// 4. Cleanup broken containers
	if err := m.cleanupBrokenContainers(ctx, projectID); err != nil {
		log.Printf("⚠️ Warning: cleanup failed: %v", err)
	}

	// 5. Create container with cross-platform mount
	resp, err := m.createContainer(ctx, projectID, projectPath)
	if err != nil {
		return nil, fmt.Errorf("container creation failed: %w", err)
	}

	// 6. Start and verify container
	if err := m.startAndVerifyContainer(ctx, resp.ID); err != nil {
		return nil, fmt.Errorf("container start/verify failed: %w", err)
	}

	ports, err := m.getPortMappings(ctx, resp.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to get ports: %w", err)
	}

	log.Printf("🎉 [CreateAndStart] Container ready on %s: %s", runtime.GOOS, resp.ID[:12])
	m.SetContainerReady(resp.ID)

	return &StartProjectResponse{
		ContainerID: resp.ID,
		Status:      "success",
		Ports:       ports,
		Message:     fmt.Sprintf("Container ready on %s - bolt.diy style", runtime.GOOS),
	}, nil
}

// Cross-platform project path handling
func (m *ContainerManager) getProjectPath(projectID string) (string, error) {
	// Get absolute path in a cross-platform way
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get current directory: %w", err)
	}

	projectPath := filepath.Join(cwd, "projects", projectID)
	absPath, err := filepath.Abs(projectPath)
	if err != nil {
		return "", fmt.Errorf("failed to get absolute path: %w", err)
	}

	log.Printf("📁 [getProjectPath] Project path on %s: %s", runtime.GOOS, absPath)
	return absPath, nil
}

// Cross-platform directory creation with proper permissions
func (m *ContainerManager) ensureProjectDirectory(projectPath string) error {
	if _, err := os.Stat(projectPath); os.IsNotExist(err) {
		// Use different permissions based on platform
		var perm os.FileMode
		if runtime.GOOS == "windows" {
			perm = 0777 // Windows doesn't use Unix permissions the same way
		} else {
			perm = 0755 // Unix-like systems (Mac, Linux)
		}

		if err := os.MkdirAll(projectPath, perm); err != nil {
			return fmt.Errorf("failed to create directory: %w", err)
		}
		log.Printf("📂 [ensureProjectDirectory] Created directory on %s: %s", runtime.GOOS, projectPath)
	} else if err != nil {
		return fmt.Errorf("failed to check directory: %w", err)
	} else {
		log.Printf("📂 [ensureProjectDirectory] Using existing directory: %s", projectPath)
	}

	return nil
}

// Cross-platform container creation
func (m *ContainerManager) createContainer(ctx context.Context, projectID, projectPath string) (container.CreateResponse, error) {
	// Convert path for Docker mount (especially important on Windows)
	mountSource := projectPath
	if runtime.GOOS == "windows" {
		// Convert Windows path to Docker-compatible format
		mountSource = strings.ReplaceAll(projectPath, "\\", "/")
		if strings.Contains(mountSource, ":") {
			// Convert C:\path to /c/path for Docker on Windows
			mountSource = "/" + strings.ToLower(string(mountSource[0])) + mountSource[2:]
		}
	}

	log.Printf("🗂️ [createContainer] Mount source on %s: %s -> /app", runtime.GOOS, mountSource)

	return m.cli.ContainerCreate(
		ctx,
		&container.Config{
			Image:      "node:20-alpine",
			Tty:        true,
			WorkingDir: "/app",
			OpenStdin:  true,
			Cmd:        []string{"tail", "-f", "/dev/null"},
			Healthcheck: &container.HealthConfig{
				Test:        []string{"CMD-SHELL", "node --version && echo 'ready'"},
				Interval:    10 * time.Second, // Increased from 5s
				Timeout:     10 * time.Second, // Increased from 3s
				Retries:     5,                // Increased from 3
				StartPeriod: 30 * time.Second, // Add start period
			},
		},
		&container.HostConfig{
			Mounts: []mount.Mount{
				{
					Type:   mount.TypeBind,
					Source: mountSource, // Use converted path
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
}

func (m *ContainerManager) startAndVerifyContainer(ctx context.Context, containerID string) error {
	// Start container
	if err := m.cli.ContainerStart(ctx, containerID, types.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("container start failed: %w", err)
	}

	log.Printf("🔄 [startAndVerifyContainer] Container started, waiting for healthy state...")

	// Wait for healthy with extended timeout
	if err := m.waitForHealthy(ctx, containerID); err != nil {
		return fmt.Errorf("container not healthy: %w", err)
	}

	// Verify command execution
	if err := m.verifyCommandExecution(ctx, containerID); err != nil {
		return fmt.Errorf("command execution failed: %w", err)
	}

	return nil
}

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
		if c.State != "running" || strings.Contains(c.Status, "unhealthy") {
			log.Printf("🗑️ Removing broken container: %s (status: %s)", c.ID[:12], c.State)
			if err := m.cli.ContainerRemove(ctx, c.ID, types.ContainerRemoveOptions{
				Force: true,
			}); err != nil {
				log.Printf("⚠️ Warning: failed to remove container %s: %v", c.ID[:12], err)
			}
		}
	}
	return nil
}

func (m *ContainerManager) waitForHealthy(ctx context.Context, containerID string) error {
	timeout := 60 * time.Second // Increased timeout for Colima
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		inspect, err := m.cli.ContainerInspect(ctx, containerID)
		if err != nil {
			log.Printf("❌ Container inspect failed: %v", err)
			return fmt.Errorf("failed to inspect container: %w", err)
		}

		log.Printf("🔍 Container %s state: Running=%v, Health=%v",
			containerID[:12], inspect.State.Running,
			func() string {
				if inspect.State.Health != nil {
					return inspect.State.Health.Status
				}
				return "no-healthcheck"
			}())

		if inspect.State.Health != nil {
			switch inspect.State.Health.Status {
			case "healthy":
				log.Printf("✅ Container %s is healthy", containerID[:12])
				return nil
			case "unhealthy":
				log.Printf("❌ Container %s became unhealthy", containerID[:12])
				return fmt.Errorf("container became unhealthy")
			}
		} else if inspect.State.Running {
			log.Printf("✅ Container %s is running (no health check)", containerID[:12])
			return nil
		}

		time.Sleep(2 * time.Second) // Increased from 1s
	}

	return fmt.Errorf("container did not become healthy within %v", timeout)
}

func (m *ContainerManager) verifyCommandExecution(ctx context.Context, containerID string) error {
	// Simple test command that works on Alpine Linux
	_, err := m.executeCommand(ctx, containerID, "echo 'container-ready'")
	if err != nil {
		log.Printf("❌ Command verification failed: %v", err)
		return err
	}
	log.Printf("✅ Container %s command execution verified", containerID[:12])
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

	log.Printf("🔌 Container %s port mappings: %+v", containerID[:12], ports)
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

	log.Printf("✅ Container %s marked as ready", containerID[:12])
}

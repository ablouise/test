package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// Request/Response types
type (
	StartProjectRequest struct {
		ProjectID string `json:"projectId"`
	}

	StartProjectResponse struct {
		ContainerID string            `json:"containerId"`
		Status      string            `json:"status"`
		Message     string            `json:"message,omitempty"`
		Ports       map[string]string `json:"ports,omitempty"`
	}
)

func main() {
	// Initialize Docker client with retry logic
	var manager *ContainerManager
	var err error

	// Retry Docker connection with backoff
	maxRetries := 3
	for i := 0; i < maxRetries; i++ {
		manager, err = NewContainerManager()
		if err == nil {
			break
		}

		if i == maxRetries-1 {
			log.Fatalf("Failed to initialize Docker client after %d attempts: %v", maxRetries, err)
		}

		waitTime := time.Duration(i+1) * time.Second
		log.Printf("Docker connection failed (attempt %d/%d), retrying in %v...", i+1, maxRetries, waitTime)
		time.Sleep(waitTime)
	}

	// Verify Docker is actually running
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := manager.cli.Ping(ctx); err != nil {
		log.Fatalf("Docker daemon not responding: %v", err)
	}

	// Cleanup stale containers (non-critical operation)
	if err := manager.cleanupExisting(context.Background(), ""); err != nil {
		log.Printf("Container cleanup warning: %v (continuing anyway)", err)
	}

	// Add health check endpoints before other handlers
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	http.HandleFunc("/health/docker", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()

		if _, err := manager.cli.Ping(ctx); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{
				"status":  "unhealthy",
				"error":   err.Error(),
				"message": "Docker daemon not available",
			})
			return
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "healthy",
			"version": "1.0",
		})
	})

	http.HandleFunc("/api/projects/start", func(w http.ResponseWriter, r *http.Request) {
		log.Println("Received /api/projects/start request")

		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			log.Println("Rejected non-POST request to /api/projects/start")
			return
		}

		var req StartProjectRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			log.Printf("Failed to parse request body: %v\n", err)
			return
		}
		log.Printf("Starting project with ID: %s\n", req.ProjectID)

		resp, err := manager.CreateAndStart(req.ProjectID)
		if err != nil {
			log.Printf("Failed to create/start container: %v\n", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		log.Printf("Container started: %s\n", resp.ContainerID)

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			log.Printf("Failed to encode response: %v\n", err)
		} else {
			log.Printf("Response sent for project %s (container %s)\n", req.ProjectID, resp.ContainerID)
		}
	})

	// WebSocket endpoint
	http.HandleFunc("/ws", handleWebSocket)

	log.Println("Starting server on :3001")
	log.Println("Health checks available at /health and /health/docker")
	log.Fatal(http.ListenAndServe(":3001", nil))
}

package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// Global container manager - this connects to your container.go
var manager *ContainerManager

func main() {
	// Initialize container manager using the NewContainerManager from container.go
	log.Println("🚀 Starting bolt.diy Docker backend...")

	var err error
	manager, err = NewContainerManager() // This comes from container.go
	if err != nil {
		log.Fatal("❌ Failed to create container manager:", err)
	}

	// Set global reference for websocket handler (from websocket.go)
	containerManager = manager

	log.Println("✅ Container manager initialized successfully")

	// Set up routes
	setupRoutes()

	// Start server
	port := ":3001"
	log.Printf("🌟 Server starting on %s", port)
	log.Printf("📡 WebSocket available at: ws://localhost%s/ws", port)

	if err := http.ListenAndServe(port, nil); err != nil {
		log.Fatal("❌ Server failed to start:", err)
	}
}

func setupRoutes() {
	// API endpoints - these use your container.go functions
	http.HandleFunc("/api/projects/start", corsMiddleware(handleProjectStart))
	http.HandleFunc("/api/containers/status", corsMiddleware(handleContainerStatus))

	// WebSocket endpoint - this uses your websocket.go handleWebSocket function
	http.HandleFunc("/ws", handleWebSocket) // handleWebSocket comes from websocket.go

	// Health check
	http.HandleFunc("/health", corsMiddleware(handleHealthCheck))

	log.Println("🛣️ Routes configured successfully")
}

func handleProjectStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "Method not allowed"})
		return
	}

	var req struct {
		ProjectID string `json:"projectId"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("❌ Error decoding request: %v", err)
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body"})
		return
	}

	if req.ProjectID == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Project ID is required"})
		return
	}

	log.Printf("🚀 Starting project: %s", req.ProjectID)

	// Use the CreateAndStart method from container.go
	response, err := manager.CreateAndStart(req.ProjectID)
	if err != nil {
		log.Printf("❌ Error creating/starting project %s: %v", req.ProjectID, err)
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	log.Printf("✅ Project %s started successfully", req.ProjectID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func handleContainerStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "Method not allowed"})
		return
	}

	var req struct {
		ContainerID string `json:"containerId"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body"})
		return
	}

	if req.ContainerID == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Container ID is required"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Use the Docker client from container.go manager
	inspect, err := manager.cli.ContainerInspect(ctx, req.ContainerID)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Container not found"})
		return
	}

	status := "stopped"
	if inspect.State.Running {
		status = "running"
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"containerId": req.ContainerID,
		"status":      status,
		"ports":       inspect.NetworkSettings.Ports,
	})
}

func handleHealthCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	// Test Docker connection using the manager from container.go
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := manager.cli.Ping(ctx)
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"status": "unhealthy",
			"error":  "Docker connection failed",
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "healthy",
		"timestamp": time.Now().UTC(),
		"service":   "bolt.diy-docker-backend",
	})
}

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "3600")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next(w, r)
	}
}

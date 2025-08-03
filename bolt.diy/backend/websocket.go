package main

import (
	"context"
	"log"
	"net/http"

	"github.com/docker/docker/client"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for development
	},
}

// Global container manager variable
var containerManager *ContainerManager

// Initialize the container manager
func init() {
	// Create Docker client first
	dockerClient, err := client.NewClientWithOpts(client.FromEnv)
	if err != nil {
		log.Fatal("Failed to create Docker client:", err)
	}

	// Create container manager with the Docker client
	containerManager = NewContainerManager(dockerClient)
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	for {
		var msg struct {
			MessageID   string `json:"messageId"`
			ContainerID string `json:"containerId"`
			Command     string `json:"command"`
		}

		if err := conn.ReadJSON(&msg); err != nil {
			log.Printf("WebSocket read error: %v", err)
			break
		}

		// Now executeCommand will work properly
		output, err := containerManager.executeCommand(context.Background(), msg.ContainerID, msg.Command)

		response := map[string]interface{}{
			"messageId": msg.MessageID,
			"type":      "output",
			"data":      output,
		}

		if err != nil {
			response["type"] = "error"
			response["data"] = err.Error()
		}

		// Send end signal
		response["type"] = "end"
		if err := conn.WriteJSON(response); err != nil {
			log.Printf("WebSocket write error: %v", err)
			break
		}
	}
}

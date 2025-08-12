package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for development
	},
}

// Global container manager reference
var containerManager *ContainerManager

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade HTTP connection to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	log.Printf("Client connected: %s", conn.RemoteAddr())

	// Handle WebSocket messages
	for {
		var msg struct {
			MessageID   string `json:"messageId"`
			ContainerID string `json:"containerId"`
			Command     string `json:"command"`
		}

		// Read JSON message from client
		if err := conn.ReadJSON(&msg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		log.Printf("Received command: %s for container: %s", msg.Command, msg.ContainerID)

		// Execute command in Docker container
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		output, err := containerManager.executeCommand(ctx, msg.ContainerID, msg.Command)
		cancel()

		// Prepare response
		response := map[string]interface{}{
			"messageId": msg.MessageID,
			"type":      "output",
			"data":      output,
		}

		if err != nil {
			response["type"] = "error"
			response["data"] = err.Error()
			log.Printf("Command execution failed: %v", err)
		}

		// Send response back to client
		if err := conn.WriteJSON(response); err != nil {
			log.Printf("Write error: %v", err)
			break
		}

		// Send end signal
		endResponse := map[string]interface{}{
			"messageId": msg.MessageID,
			"type":      "end",
			"data":      "",
		}

		if err := conn.WriteJSON(endResponse); err != nil {
			log.Printf("Write end signal error: %v", err)
			break
		}
	}

	log.Printf("Client disconnected: %s", conn.RemoteAddr())
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var (
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}
	connMutex   sync.Mutex
	activeConns = make(map[string]*websocket.Conn)
)

type CommandRequest struct {
	MessageID   string `json:"messageId"`
	ContainerID string `json:"containerId"`
	Command     string `json:"command"`
}

type CommandResponse struct {
	Type      string `json:"type"`
	Data      string `json:"data"`
	MessageID string `json:"messageId,omitempty"`
}

var containerManager *ContainerManager

func init() {
	var err error
	containerManager, err = NewContainerManager()
	if err != nil {
		log.Fatalf("Failed to create container manager: %v", err)
	}
}

func executeCommand(conn *websocket.Conn, cmdReq CommandRequest) {
	ctx := context.Background()

	// Use containerManager instead of dockerCli
	out, err := containerManager.executeCommand(ctx, cmdReq.ContainerID, cmdReq.Command)
	if err != nil {
		sendError(conn, err.Error(), cmdReq.MessageID)
		return
	}

	sendResponse(conn, CommandResponse{
		Type:      "output",
		Data:      out,
		MessageID: cmdReq.MessageID,
	})

	sendResponse(conn, CommandResponse{
		Type:      "end",
		MessageID: cmdReq.MessageID,
	})
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	connMutex.Lock()
	connID := fmt.Sprintf("%p", conn)
	activeConns[connID] = conn
	connMutex.Unlock()

	remoteAddr := conn.RemoteAddr().String()
	log.Printf("WebSocket connected: %s", remoteAddr)

	defer func() {
		connMutex.Lock()
		delete(activeConns, connID)
		connMutex.Unlock()
		log.Printf("WebSocket disconnected: %s", remoteAddr)
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err) {
				log.Printf("WebSocket unexpected close: %v", err)
			}
			break
		}

		var cmdReq CommandRequest
		if err := json.Unmarshal(msg, &cmdReq); err != nil {
			sendError(conn, "invalid command format", "")
			continue
		}

		log.Printf("Executing command: %s (Container: %s)", cmdReq.Command, cmdReq.ContainerID)
		go executeCommand(conn, cmdReq)
	}
}

func sendResponse(conn *websocket.Conn, resp CommandResponse) {
	connMutex.Lock()
	defer connMutex.Unlock()

	if err := conn.WriteJSON(resp); err != nil {
		log.Printf("WebSocket write error: %v", err)
	}
}

func sendError(conn *websocket.Conn, message string, messageID string) {
	log.Printf("Sending error response: %s (MessageID: %s)", message, messageID)
	sendResponse(conn, CommandResponse{
		Type:      "error",
		Data:      message,
		MessageID: messageID,
	})
}

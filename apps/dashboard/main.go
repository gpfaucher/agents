package main

import (
	"embed"
	"flag"
	"log"
	"net/http"
	"os"

	"github.com/gpfaucher/agents/apps/dashboard/internal/server"
	"github.com/gpfaucher/agents/apps/dashboard/internal/store"
)

//go:embed static
var staticFS embed.FS

func main() {
	port := flag.String("port", getEnv("PORT", "8080"), "HTTP port")
	dbPath := flag.String("db", getEnv("DB_PATH", "dashboard.db"), "SQLite database path")
	flag.Parse()

	db, err := store.New(*dbPath)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()

	srv := server.New(db, staticFS)
	log.Printf("Dashboard listening on :%s", *port)
	if err := http.ListenAndServe(":"+*port, srv.Router()); err != nil {
		log.Fatal(err)
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

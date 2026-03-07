package server

import (
	"embed"
	"io/fs"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gpfaucher/agents/apps/dashboard/internal/handlers"
	"github.com/gpfaucher/agents/apps/dashboard/internal/store"
)

//go:embed ../../static
var staticFS embed.FS

type Server struct {
	store *store.Store
}

func New(s *store.Store) *Server {
	return &Server{store: s}
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	h := handlers.New(s.store)

	// Pages
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/agents", http.StatusFound)
	})
	r.Get("/agents", h.AgentsPage)
	r.Get("/costs", h.CostsPage)

	// API
	r.Post("/api/runs", h.CreateRun)
	r.Get("/api/runs", h.ListRuns)

	// Static files
	sub, _ := fs.Sub(staticFS, "static")
	r.Handle("/static/*", http.StripPrefix("/static/", http.FileServer(http.FS(sub))))

	return r
}

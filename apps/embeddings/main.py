"""Lightweight embedding server using sentence-transformers."""
import os
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
PORT = int(os.environ.get("PORT", "8080"))

print(f"Loading model: {MODEL_NAME}")
model = SentenceTransformer(MODEL_NAME)
print(f"Model loaded. Dimension: {model.get_sentence_embedding_dimension()}")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/embed":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))

            text = body.get("text", "")
            texts = body.get("texts", [])

            if text and not texts:
                texts = [text]

            if not texts:
                self.send_error(400, "Missing 'text' or 'texts' field")
                return

            embeddings = model.encode(texts).tolist()

            response = {
                "embeddings": embeddings,
                "dimension": model.get_sentence_embedding_dimension(),
            }
            # Convenience: if single text was sent, also include singular
            if text and not body.get("texts"):
                response["embedding"] = embeddings[0]

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

        elif self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        else:
            self.send_error(404)

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")
        elif self.path == "/info":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "model": MODEL_NAME,
                "dimension": model.get_sentence_embedding_dimension(),
            }).encode())
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        # Quieter logging
        pass


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Embedding server listening on :{PORT}")
    server.serve_forever()

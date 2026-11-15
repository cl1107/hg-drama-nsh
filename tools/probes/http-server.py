from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(302 if self.path == '/redirect' else 200)
  if self.path == '/redirect': self.send_header('Location', '/final')
  self.send_header('Set-Cookie', 'first=one; Path=/; HttpOnly')
  self.send_header('Set-Cookie', 'second=two; Path=/; HttpOnly')
  self.end_headers()
  self.wfile.write(b'probe')
 def log_message(self, *args): pass
HTTPServer(('127.0.0.1', 18791), Handler).serve_forever()

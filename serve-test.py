import os, http.server, socketserver
os.chdir('/Users/kevinbrittain/Projects/leadership-dashboard')
socketserver.TCPServer(('', 8765), http.server.SimpleHTTPRequestHandler).serve_forever()

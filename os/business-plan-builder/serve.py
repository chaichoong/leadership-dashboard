#!/usr/bin/env python3
"""
Business Plan Builder — Local development server with API proxy.
Serves static files AND proxies AI API calls to avoid browser CORS issues.
"""
import http.server
import json
import os
import urllib.request
import urllib.error
import ssl

os.chdir('/tmp/bplan-preview')

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/api/chat':
            self.proxy_api_call()
        else:
            self.send_error(404, 'Not found')

    def proxy_api_call(self):
        try:
            # Read the request body from the browser
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            data = json.loads(body)

            provider = data.get('provider', 'anthropic')
            api_key = data.get('apiKey', '')
            model = data.get('model', '')
            system_prompt = data.get('system', '')
            messages = data.get('messages', [])
            endpoint = data.get('endpoint', '')

            if provider == 'anthropic':
                result = self.call_anthropic(api_key, model, system_prompt, messages)
            elif provider == 'openai':
                result = self.call_openai(api_key, model, system_prompt, messages)
            elif provider == 'custom':
                result = self.call_custom(endpoint, api_key, model, system_prompt, messages)
            else:
                result = {'error': 'Unknown provider: ' + provider}

            response_body = json.dumps(result).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)

        except Exception as e:
            error_body = json.dumps({'error': str(e)}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(error_body)))
            self.end_headers()
            self.wfile.write(error_body)

    def do_OPTIONS(self):
        """Handle CORS preflight requests."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def call_anthropic(self, api_key, model, system_prompt, messages):
        url = 'https://api.anthropic.com/v1/messages'
        headers = {
            'Content-Type': 'application/json',
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01'
        }
        payload = json.dumps({
            'model': model,
            'max_tokens': 1500,
            'system': system_prompt,
            'messages': messages
        }).encode('utf-8')

        req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
        ctx = ssl.create_default_context()

        try:
            with urllib.request.urlopen(req, context=ctx) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                if 'content' in result and len(result['content']) > 0:
                    return {'text': result['content'][0]['text']}
                return {'error': 'Unexpected Anthropic response format'}
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')[:500]
            return {'error': f'Anthropic API error {e.code}: {error_body}'}

    def call_openai(self, api_key, model, system_prompt, messages):
        url = 'https://api.openai.com/v1/chat/completions'
        headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + api_key
        }
        msgs = [{'role': 'system', 'content': system_prompt}] + messages
        payload = json.dumps({
            'model': model,
            'max_tokens': 1500,
            'messages': msgs
        }).encode('utf-8')

        req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
        ctx = ssl.create_default_context()

        try:
            with urllib.request.urlopen(req, context=ctx) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                if 'choices' in result and len(result['choices']) > 0:
                    return {'text': result['choices'][0]['message']['content']}
                return {'error': 'Unexpected OpenAI response format'}
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')[:500]
            return {'error': f'OpenAI API error {e.code}: {error_body}'}

    def call_custom(self, endpoint, api_key, model, system_prompt, messages):
        headers = {'Content-Type': 'application/json'}
        if api_key:
            headers['Authorization'] = 'Bearer ' + api_key
        msgs = [{'role': 'system', 'content': system_prompt}] + messages
        payload = json.dumps({
            'model': model,
            'messages': msgs
        }).encode('utf-8')

        req = urllib.request.Request(endpoint, data=payload, headers=headers, method='POST')
        ctx = ssl.create_default_context()

        try:
            with urllib.request.urlopen(req, context=ctx) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                if 'choices' in result and len(result['choices']) > 0:
                    return {'text': result['choices'][0]['message']['content']}
                if 'content' in result and len(result['content']) > 0:
                    return {'text': result['content'][0]['text']}
                if 'text' in result:
                    return {'text': result['text']}
                if 'response' in result:
                    return {'text': result['response']}
                return {'error': 'Could not parse response from custom endpoint'}
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')[:500]
            return {'error': f'Custom API error {e.code}: {error_body}'}

    def log_message(self, format, *args):
        """Only log errors, not every request."""
        if '404' in str(args) or '500' in str(args):
            super().log_message(format, *args)


if __name__ == '__main__':
    print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    print('  Business Plan Builder — Dev Server')
    print('  Open: http://localhost:8095/')
    print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    server = http.server.HTTPServer(('', 8095), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')

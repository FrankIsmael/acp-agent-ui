#!/usr/bin/env python3
"""CI's deploy trigger. Caddy forwards POST /_deploy here over a unix socket.

With the right bearer token it runs deploy.sh and answers with its output:
200 when the deploy succeeded (or there was nothing new), 500 when it did not.
The workflow prints that answer, so the deploy result shows up in GitHub.

The token can only ask for "deploy the current :main", never a given image or
command. Runs as `opc` from acp-deploy-hook.service; DEPLOY_TOKEN comes from
/etc/acp-deploy.env. Standard library only: Oracle Linux 9 ships Python 3.9.
"""
import hmac
import os
import re
import socketserver
import subprocess
import sys
from http.server import BaseHTTPRequestHandler

SOCKET = os.environ.get('DEPLOY_HOOK_SOCKET', '/run/acp-deploy/hook.sock')
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'deploy.sh')
TOKEN = os.environ.get('DEPLOY_TOKEN', '').encode()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        given = self.headers.get('Authorization', '').encode()
        if not hmac.compare_digest(given, b'Bearer ' + TOKEN):
            return self.reply(401, 'unauthorized\n')
        env = dict(os.environ)
        del env['DEPLOY_TOKEN']
        expect = self.headers.get('X-Revision', '')
        if expect:
            if not re.fullmatch(r'[0-9a-f]{40}', expect):
                return self.reply(400, 'X-Revision must be a full commit sha\n')
            env['DEPLOY_EXPECT'] = expect
        try:
            done = subprocess.run(
                ['/bin/bash', SCRIPT],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=1200,
            )
        except subprocess.TimeoutExpired:
            return self.reply(504, 'deploy.sh still running after 20 minutes\n')
        output = done.stdout.decode(errors='replace')
        self.reply(200 if done.returncode == 0 else 500, output)

    def reply(self, status, text):
        body = text.encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # The default logger reads a client address, which a unix socket lacks.
    def log_message(self, format, *args):
        print(format % args, flush=True)


def main():
    if len(TOKEN) < 32:
        sys.exit('DEPLOY_TOKEN is missing or shorter than 32 characters')
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    # One request at a time: deploys queue up instead of racing.
    with socketserver.UnixStreamServer(SOCKET, Handler) as server:
        os.chmod(SOCKET, 0o660)
        print(f'listening on {SOCKET}', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()

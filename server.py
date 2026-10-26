# -*- coding: utf-8 -*-
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.parse

rates = {
    "on_peak": "4.1839",
    "off_peak": "2.6037"
}

HTML = """<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="utf-8">
    <title>ทดสอบค่าไฟ</title>
</head>
<body style="font-family: sans-serif; padding: 30px; line-height: 1.8;">
    <h2>⚡ หน้าทดสอบค่าไฟฟ้า</h2>
    <form method="POST" action="/">
        <label>On-Peak: </label><input type="text" name="on_peak" value="__ON_PEAK__"><br>
        <label>Off-Peak: </label><input type="text" name="off_peak" value="__OFF_PEAK__"><br><br>
        <button type="submit" style="padding: 6px 18px; cursor: pointer;">บันทึก</button>
    </form>
    <hr>
    <h3>ค่าปัจจุบันบนหน้าเว็บ:</h3>
    <p>ค่าไฟ On-Peak: <b id="on-peak">__ON_PEAK__</b> บาท/หน่วย</p>
    <p>ค่าไฟ Off-Peak: <b id="off-peak">__OFF_PEAK__</b> บาท/หน่วย</p>
</body>
</html>"""

class SimpleHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        page = HTML.replace("__ON_PEAK__", rates["on_peak"]).replace("__OFF_PEAK__", rates["off_peak"])
        self.wfile.write(page.encode('utf-8'))

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8')
        params = urllib.parse.parse_qs(body)
        if 'on_peak' in params:
            rates['on_peak'] = params['on_peak'][0].strip()
        if 'off_peak' in params:
            rates['off_peak'] = params['off_peak'][0].strip()
        self.send_response(303)
        self.send_header('Location', '/')
        self.end_headers()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    server = HTTPServer(('0.0.0.0', port), SimpleHandler)
    print(f"Server running on port {port}")
    server.serve_forever()

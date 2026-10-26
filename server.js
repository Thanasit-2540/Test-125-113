const http = require('http');
const querystring = require('querystring');

let rates = {
  on_peak: '4.1839',
  off_peak: '2.6037'
};

function getHtml(onPeak, offPeak) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="utf-8">
    <title>ทดสอบค่าไฟ</title>
</head>
<body style="font-family: sans-serif; padding: 30px; line-height: 1.8;">
    <h2>⚡ หน้าทดสอบค่าไฟฟ้า</h2>
    <form method="POST" action="/">
        <label>On-Peak: </label><input type="text" name="on_peak" value="${onPeak}"><br>
        <label>Off-Peak: </label><input type="text" name="off_peak" value="${offPeak}"><br><br>
        <button type="submit" style="padding: 6px 18px; cursor: pointer;">บันทึก</button>
    </form>
    <hr>
    <h3>ค่าปัจจุบันบนหน้าเว็บ:</h3>
    <p>ค่าไฟ On-Peak: <b id="on-peak">${onPeak}</b> บาท/หน่วย</p>
    <p>ค่าไฟ Off-Peak: <b id="off-peak">${offPeak}</b> บาท/หน่วย</p>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const parsed = querystring.parse(body);
      if (parsed.on_peak) rates.on_peak = parsed.on_peak.trim();
      if (parsed.off_peak) rates.off_peak = parsed.off_peak.trim();
      res.writeHead(303, { Location: '/' });
      res.end();
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHtml(rates.on_peak, rates.off_peak));
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

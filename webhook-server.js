const http = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");
const path = require("path");

const PORT = process.env.WEBHOOK_PORT || 9000;
const SECRET = process.env.WEBHOOK_SECRET || "";
const DEPLOY_SCRIPT = path.join(__dirname, "deploy.sh");

function verifySignature(payload, signature) {
  if (!SECRET) return false;
  if (!signature) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", SECRET).update(payload, "utf8").digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

function runDeploy() {
  console.log(`[webhook] running ${DEPLOY_SCRIPT}`);
  exec(
    `bash "${DEPLOY_SCRIPT}" >> /root/courier-shift-bot/webhook-deploy.log 2>&1`,
    (error, stdout, stderr) => {
      if (error) {
        console.error("[webhook] deploy error:", error.message);
        return;
      }
      console.log("[webhook] deploy completed");
    },
  );
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook/deploy") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const ua = req.headers["user-agent"] || "";
  if (!ua.startsWith("GitHub-Hookshot")) {
    res.statusCode = 403;
    res.end("invalid user-agent");
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const payload = Buffer.concat(chunks).toString("utf8");
    const signature = req.headers["x-hub-signature-256"] || "";

    if (!verifySignature(payload, signature)) {
      res.statusCode = 403;
      res.end("invalid signature");
      return;
    }

    let event = req.headers["x-github-event"] || "";
    if (event === "push") {
      try {
        const data = JSON.parse(payload);
        const ref = data.ref || "";
        if (ref === "refs/heads/main") {
          runDeploy();
        }
      } catch (e) {
        console.error("[webhook] parse error:", e.message);
      }
    }

    res.statusCode = 200;
    res.end("ok");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[webhook] listening on 127.0.0.1:${PORT}`);
});

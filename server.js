const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const ASAAS_API = process.env.ASAAS_API_URL || "https://api.asaas.com/v3";
const ASAAS_KEY = process.env.ASAAS_API_KEY || "";
const WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "";
const APP_SECRET = process.env.APP_SECRET || "";

const albums = [
  {
    id: "jogo-futebol",
    name: "Jogo de Futebol",
    price: 20,
    photos: [
      "https://images.unsplash.com/photo-1521412644187-c49fa049e84d?auto=format&fit=crop&w=1000&q=85",
      "https://images.unsplash.com/photo-1579952363873-27f3bade9f55?auto=format&fit=crop&w=1000&q=85",
      "https://images.unsplash.com/photo-1553778263-73a83bab9b0c?auto=format&fit=crop&w=1000&q=85"
    ]
  },
  {
    id: "campeonato",
    name: "Campeonato",
    price: 25,
    photos: [
      "https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?auto=format&fit=crop&w=1000&q=85",
      "https://images.unsplash.com/photo-1517466787929-bc90951d0974?auto=format&fit=crop&w=1000&q=85",
      "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=1000&q=85"
    ]
  }
];

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "access_token": ASAAS_KEY
  };
}

async function asaas(path, options = {}) {
  const response = await fetch(`${ASAAS_API}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.errors?.[0]?.description || "Erro na API do Asaas");
  return data;
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}
function sign(value) {
  return crypto.createHmac("sha256", APP_SECRET).update(value).digest("base64url");
}
function makeDeliveryToken(payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}
function verifyDeliveryToken(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature || !APP_SECRET) return null;
  const expected = sign(body);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

async function sendEmail(to, links, order) {
  if (!RESEND_KEY || !FROM_EMAIL) {
    console.log("RESEND não configurado; entrega registrada:", { to, links });
    return;
  }
  const html = `
    <h2>Gabriel Altino Fotografia</h2>
    <p>Seu pagamento foi confirmado. 📸</p>
    <p>Suas fotos estão disponíveis abaixo:</p>
    ${links.map((url, i) => `<p><a href="${url}" target="_blank">Baixar foto ${i + 1}</a></p>`).join("")}
    <p>Pedido: ${order.id}</p>
  `;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject: "Suas fotos - Gabriel Altino Fotografia",
      html
    })
  });
  if (!response.ok) throw new Error("Falha ao enviar e-mail");
}

app.get("/api/albums", (req, res) => {
  res.json(albums);
});

app.post("/api/create-payment", async (req, res) => {
  try {
    if (!ASAAS_KEY) return res.status(500).json({ error: "ASAAS_API_KEY não configurada" });

    const { name, email, albumId, selectedPhotos, amount } = req.body;
    if (!name || !email || !albumId || !Array.isArray(selectedPhotos) || !selectedPhotos.length) {
      return res.status(400).json({ error: "Dados do pedido incompletos" });
    }

    const album = albums.find(a => a.id === albumId);
    if (!album) return res.status(400).json({ error: "Álbum inválido" });

    const photos = selectedPhotos
      .map(i => album.photos[Number(i)])
      .filter(Boolean);

    if (!photos.length) return res.status(400).json({ error: "Fotos inválidas" });

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: "Valor inválido" });

    const orderId = `GA-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

    const customer = await asaas("/customers", {
      method: "POST",
      body: JSON.stringify({
        name,
        email,
        notificationDisabled: true,
        externalReference: orderId
      })
    });

    const reference = b64url(JSON.stringify({
      id: orderId,
      email,
      albumId,
      photos,
      amount: value
    }));

    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const payment = await asaas("/payments", {
      method: "POST",
      body: JSON.stringify({
        customer: customer.id,
        billingType: "PIX",
        value,
        dueDate,
        description: `Fotos - ${album.name}`,
        externalReference: reference
      })
    });

    const qr = await asaas(`/payments/${payment.id}/pixQrCode`, { method: "GET" });

    res.json({
      orderId,
      paymentId: payment.id,
      qrCode: qr.encodedImage,
      payload: qr.payload,
      expirationDate: qr.expirationDate
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Não foi possível criar o Pix" });
  }
});

app.post("/webhooks/asaas", async (req, res) => {
  if (WEBHOOK_TOKEN && req.get("asaas-access-token") !== WEBHOOK_TOKEN) {
    return res.status(401).json({ error: "Webhook não autorizado" });
  }

  res.sendStatus(200);

  try {
    if (req.body?.event !== "PAYMENT_RECEIVED") return;

    const payment = req.body.payment;
    if (!payment?.id) return;

    // O Asaas recomenda usar externalReference para conciliar o pagamento ao pedido.
    const fullPayment = await asaas(`/payments/${payment.id}`, { method: "GET" });
    if (fullPayment.status !== "RECEIVED") return;

    const reference = fullPayment.externalReference;
    if (!reference) return;

    const order = JSON.parse(Buffer.from(reference, "base64url").toString("utf8"));

    const token = makeDeliveryToken({
      orderId: order.id,
      email: order.email,
      photos: order.photos,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000
    });

    const baseUrl = process.env.PUBLIC_BASE_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
    const deliveryUrl = `${baseUrl}/entrega/${token}`;

    await sendEmail(order.email, [deliveryUrl], order);
    console.log("Pedido pago e entrega enviada:", order.id);
  } catch (error) {
    console.error("Erro no webhook:", error);
  }
});

app.get("/entrega/:token", (req, res) => {
  try {
    const payload = verifyDeliveryToken(req.params.token);
    if (!payload) return res.status(403).send("Link de entrega inválido ou expirado.");

    const items = payload.photos.map((url, i) =>
      `<p><a href="${url}" target="_blank" rel="noopener">📸 Abrir foto ${i + 1}</a></p>`
    ).join("");

    res.send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suas fotos</title><body style="font-family:Arial;background:#0b0b0d;color:white;padding:30px;max-width:700px;margin:auto"><h1>Gabriel Altino Fotografia</h1><p>Pagamento confirmado! Suas fotos:</p>${items}<p style="color:#aaa">Este link expira em 7 dias.</p></body></html>`);
  } catch {
    res.status(403).send("Link de entrega inválido.");
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    service: "Gabriel Altino Fotografia",
    asaasConfigured: Boolean(ASAAS_KEY),
    emailConfigured: Boolean(RESEND_KEY && FROM_EMAIL),
    webhookConfigured: Boolean(WEBHOOK_TOKEN)
  });
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gabriel Altino Fotografia rodando na porta ${PORT}`);
});

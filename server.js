const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));

/* ---------------- CONFIG ---------------- */

const MAX_NUMBER = 200000;
const DB_FILE = "/var/data/tickets.json";

// Asegura que exista el directorio del disk montado
if (!fs.existsSync("/var/data")) {
  fs.mkdirSync("/var/data", { recursive: true });
}

/* ---------------- DB SAFE ---------------- */

function ensureDBShape(db) {
  if (!db || typeof db !== "object") db = {};
  if (!Array.isArray(db.used)) db.used = [];
  if (!db.orders || typeof db.orders !== "object") db.orders = {};
  return db;
}

function getDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ used: [], orders: {} }, null, 2));
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    if (!raw.trim()) return ensureDBShape({ used: [], orders: {} });
    return ensureDBShape(JSON.parse(raw));
  } catch (e) {
    return ensureDBShape({ used: [], orders: {} });
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(ensureDBShape(db), null, 2));
}

/* ---------------- SIMPLE LOCK ---------------- */
// Evita duplicados por concurrencia (webhooks simultáneos)
let writing = false;
async function withLock(fn) {
  while (writing) await new Promise((r) => setTimeout(r, 50));
  writing = true;
  try {
    return await fn();
  } finally {
    writing = false;
  }
}

/* ---------------- HELPERS ---------------- */

function normalizeCLP(value) {
  // Soporta "5000", "5000.00", "$5.000", "5.000", "5,000", "5000,00", etc.
  const s = String(value ?? "").trim();
  if (!s) return NaN;

  let clean = s.replace(/[^\d.,-]/g, "");

  // Si tiene '.' y NO tiene ',', asumimos '.' como miles si el último bloque tiene 3 dígitos
  if (clean.includes(".") && !clean.includes(",")) {
    const parts = clean.split(".");
    const last = parts[parts.length - 1];
    if (last.length === 3) clean = parts.join("");
  }

  // Si tiene ',' y NO tiene '.', tomamos ',' como decimal
  if (clean.includes(",") && !clean.includes(".")) {
    clean = clean.replace(",", ".");
  }

  // Si tiene ambos, dejamos solo el último separador como decimal
  if (clean.includes(",") && clean.includes(".")) {
    const lastComma = clean.lastIndexOf(",");
    const lastDot = clean.lastIndexOf(".");
    const decPos = Math.max(lastComma, lastDot);

    const intPart = clean.slice(0, decPos).replace(/[.,]/g, "");
    const decPart = clean.slice(decPos + 1).replace(/[^\d]/g, "");
    clean = decPart ? `${intPart}.${decPart}` : intPart;
  }

  const n = Number(clean);
  return Number.isFinite(n) ? n : NaN;
}

function calcExpectedQtyFromOrder(order) {
  let qty = 0;
  (order.line_items || []).forEach((item) => {
    const price = normalizeCLP(item.price);
    const q = Number(item.quantity || 1);

    if (price === 1000) qty += 1 * q;
    if (price === 3000) qty += 5 * q;
    if (price === 5000) qty += 10 * q;
  });
  return qty;
}

/* ---------------- GENERADOR ---------------- */

function generateTickets(db, qty) {
  qty = Number(qty) || 0;
  if (qty <= 0) return [];

  const maxStart = MAX_NUMBER - qty;
  if (maxStart <= 0) return [];

  const usedSet = new Set(db.used);

  let start;
  let valid = false;

  // Recomendación: tickets desde 1 (no 0)
  // Si quieres permitir 0, cambia start = 0 y has start + i
  while (!valid) {
    start = 1 + Math.floor(Math.random() * maxStart); // 1..maxStart
    valid = true;

    for (let i = 0; i < qty; i++) {
      if (usedSet.has(start + i)) {
        valid = false;
        break;
      }
    }
  }

  const tickets = [];
  for (let i = 0; i < qty; i++) {
    const n = start + i;
    tickets.push(n);
    db.used.push(n);
    usedSet.add(n);
  }

  return tickets;
}

/* ---------------- RESEND (timeout corto) ---------------- */

async function sendWithResend({ to, subject, html, replyTo, timeoutMs = 5000 }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;

  if (!apiKey) throw new Error("RESEND_API_KEY no está configurada");
  if (!from) throw new Error("RESEND_FROM no está configurada");

  // ✅ TEXTO PLANO (anti-spam)
  const text = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        from,
        to,
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      throw new Error(data?.message || `Resend error HTTP ${resp.status}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- WEBHOOK ---------------- */

app.post("/webhook", async (req, res) => {
  const order = req.body;

  const orderNumber = order?.order_number; // ej 1056
  const orderId = order?.id; // id interno Shopify
  const emailIncoming = order?.email || null;

  console.log("🧾 Pedido recibido:", orderNumber);

  if (!orderNumber || !orderId) {
    return res.status(400).send({ error: "Order inválida (sin order_number o id)" });
  }

  // 1) Generación + guardado IDEMPOTENTE con lock
  const { tickets, shouldSendEmail, sendToEmail } = await withLock(async () => {
    const db = getDB();

    // Si ya existe la orden:
    if (db.orders[orderNumber]) {
      const existing = db.orders[orderNumber];
      const existingTickets = existing.tickets || [];

      // Si llega con email distinto, IGNORAR (no enviar a otro)
      if (existing.email && emailIncoming && existing.email !== emailIncoming) {
        console.log(
          `⚠️ Orden ${orderNumber} llegó con email distinto (${emailIncoming}). Se mantiene email original (${existing.email}).`
        );
      }

      console.log("♻️ Orden repetida, devolviendo mismos tickets");

      const canSend = !!(existing.email && !existing.emailSent && existingTickets.length);

      if (canSend) {
        existing.emailSent = true;
        saveDB(db);
        return { tickets: existingTickets, shouldSendEmail: true, sendToEmail: existing.email };
      }

      return {
        tickets: existingTickets,
        shouldSendEmail: false,
        sendToEmail: existing.email || null,
      };
    }

    // ✅ Orden nueva: calcular qty (soporta quantity + BLINDA CLP)
    const qty = calcExpectedQtyFromOrder(order);

    // ✅ LOGS TEMPORALES (para confirmar 1-2 días y luego borrar)
    console.log(
      "🧾 line_items:",
      (order.line_items || []).map((i) => ({
        title: i.title,
        price: i.price,
        quantity: i.quantity,
      }))
    );
    console.log("🎟️ qty tickets calculada:", qty);

    const ticketsNew = qty > 0 ? generateTickets(db, qty) : [];

    db.orders[orderNumber] = {
      tickets: ticketsNew,
      email: emailIncoming,
      shopifyOrderId: orderId,
      createdAt: new Date().toISOString(),
      emailSent: false,
      expectedQty: qty,
    };

    let canSend = false;
    if (emailIncoming && ticketsNew.length) {
      db.orders[orderNumber].emailSent = true;
      canSend = true;
    }

    saveDB(db);

    console.log("🔥 Tickets generados:", ticketsNew);
    return { tickets: ticketsNew, shouldSendEmail: canSend, sendToEmail: emailIncoming };
  });

  // ✅ 2) RESPONDER 200 OK INMEDIATO
  res.status(200).send({ tickets });

  // 3) Todo lo lento va DESPUÉS (background)
  setImmediate(async () => {
    if (shouldSendEmail && sendToEmail && tickets.length) {
      try {
        const subject = "🎟️ Tus números de rifa";
        const html = `
          <h2>Gracias por tu compra</h2>
          <p>Estos son tus números:</p>
          <h3>${tickets.join(", ")}</h3>
          <p>Mucha suerte 🍀</p>
        `;

        const replyTo = process.env.REPLY_TO || null;

        await sendWithResend({
          to: sendToEmail,
          subject,
          html,
          replyTo,
          timeoutMs: 5000,
        });

        console.log(`📧 Email enviado (Resend) a ${sendToEmail} (orden ${orderNumber})`);
      } catch (err) {
        console.log(`❌ Error enviando email (Resend) orden ${orderNumber}:`, err.message);

        await withLock(async () => {
          const db2 = getDB();
          if (db2.orders[orderNumber]) {
            db2.orders[orderNumber].emailSent = false;
            saveDB(db2);
          }
        });
      }
    } else {
      console.log(
        `✉️ No se envía email (orden ${orderNumber}) (ya enviado o sin email o sin tickets)`
      );
    }

    // 3B) Shopify update (opcional)
    try {
      if (process.env.SHOPIFY_STORE && process.env.SHOPIFY_ACCESS_TOKEN) {
        await axios.put(
          `https://${process.env.SHOPIFY_STORE}/admin/api/2023-10/orders/${orderId}.json`,
          {
            order: {
              id: orderId,
              note: "🎟️ Tickets: " + tickets.join(", "),
              note_attributes: [{ name: "Tickets", value: tickets.join(", ") }],
              tags: "rifa, tickets-generados",
            },
          },
          {
            headers: {
              "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
              "Content-Type": "application/json",
            },
            timeout: 5000,
          }
        );

        console.log(`✅ Tickets guardados en Shopify (orden ${orderNumber})`);
      } else {
        console.log("ℹ️ Shopify env vars no configuradas, saltando guardado en Shopify");
      }
    } catch (err) {
      console.log("❌ Error guardando en Shopify:", err.response?.data || err.message);
    }
  });
});

/* ---------------- SERVER ---------------- */

app.get("/", (req, res) => {
  res.send("Servidor activo");
});

app.get("/tickets", (req, res) => {
  const orderNumber = String(req.query.order || "").trim();
  const db = getDB();

  if (!orderNumber) return res.status(400).send("Orden no especificada");

  if (!db.orders || !db.orders[orderNumber]) {
    return res.status(404).send("No se encontraron tickets");
  }

  const data = db.orders[orderNumber];
  const tickets = data.tickets || [];

  if (!tickets.length) return res.status(404).send("No se encontraron tickets");

  res.send(`
    <h1>Tus números de rifa</h1>
    <p><b>Orden:</b> ${orderNumber}</p>
    <h2>${tickets.join(", ")}</h2>
  `);
});

/* ---------------- ADMIN TOKEN ---------------- */
function requireAdmin(req, res) {
  const token = String(req.query.token || req.headers["x-admin-token"] || "");
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    res.status(500).send("ADMIN_TOKEN no está configurado en Render");
    return false;
  }
  if (!token || token !== adminToken) {
    res.status(401).send("No autorizado");
    return false;
  }
  return true;
}

/* ---------------- ADMIN: REPAIR ORDER ---------------- */
/**
 * GET /admin/repair?order=1204&expected=34&token=XXX
 */
app.get("/admin/repair", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const orderNumber = String(req.query.order || "").trim();
  const expectedFromQuery = req.query.expected ? Number(req.query.expected) : null;

  if (!orderNumber) return res.status(400).send("Falta ?order=####");

  const result = await withLock(async () => {
    const db = getDB();
    const ord = db.orders?.[orderNumber];

    if (!ord) return { ok: false, code: 404, msg: "Orden no existe en DB" };

    const current = Array.isArray(ord.tickets) ? ord.tickets : [];
    const expected =
      Number.isFinite(expectedFromQuery) && expectedFromQuery > 0
        ? expectedFromQuery
        : Number(ord.expectedQty || current.length);

    const missing = expected - current.length;

    if (missing <= 0) {
      ord.expectedQty = expected;
      saveDB(db);
      return {
        ok: true,
        repaired: false,
        order: orderNumber,
        expected,
        current: current.length,
        added: 0,
        tickets: current,
      };
    }

    const newOnes = generateTickets(db, missing);
    ord.tickets = current.concat(newOnes);
    ord.expectedQty = expected;

    saveDB(db);

    return {
      ok: true,
      repaired: true,
      order: orderNumber,
      expected,
      current: ord.tickets.length,
      added: newOnes.length,
      addedTickets: newOnes,
      tickets: ord.tickets,
    };
  });

  if (!result.ok) return res.status(result.code).send(result.msg);
  return res.status(200).json(result);
});

/* ---------------- ADMIN: RESEND FULL EMAIL ---------------- */
/**
 * GET /admin/resend?order=1204&token=XXX
 */
app.get("/admin/resend", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const orderNumber = String(req.query.order || "").trim();
  if (!orderNumber) return res.status(400).send("Falta ?order=####");

  const payload = await withLock(async () => {
    const db = getDB();
    const ord = db.orders?.[orderNumber];
    if (!ord) return { ok: false, code: 404, msg: "Orden no existe en DB" };

    const tickets = Array.isArray(ord.tickets) ? ord.tickets : [];
    const email = ord.email || null;

    if (!email) return { ok: false, code: 400, msg: "Orden no tiene email guardado" };
    if (!tickets.length) return { ok: false, code: 400, msg: "Orden no tiene tickets" };

    ord.emailSent = true;
    saveDB(db);

    return { ok: true, email, tickets };
  });

  if (!payload.ok) return res.status(payload.code).send(payload.msg);

  res.status(200).send(`OK: reenviando a ${payload.email} (orden ${orderNumber})`);

  setImmediate(async () => {
    try {
      const subject = "🎟️ Tus números de rifa (actualizados)";
      const html = `
        <h2>Gracias por tu compra</h2>
        <p>Estos son tus números:</p>
        <h3>${payload.tickets.join(", ")}</h3>
        <p>Mucha suerte 🍀</p>
      `;
      const replyTo = process.env.REPLY_TO || null;

      await sendWithResend({
        to: payload.email,
        subject,
        html,
        replyTo,
        timeoutMs: 5000,
      });

      console.log(`📧 Reenvío OK a ${payload.email} (orden ${orderNumber})`);
    } catch (err) {
      console.log(`❌ Error reenvío (orden ${orderNumber}):`, err.message);

      await withLock(async () => {
        const db2 = getDB();
        if (db2.orders?.[orderNumber]) {
          db2.orders[orderNumber].emailSent = false;
          saveDB(db2);
        }
      });
    }
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});


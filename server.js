const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));

/* ---------------- RESEND ---------------- */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "onboarding@resend.dev"; // mejor luego usar tu dominio
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://rifas-jean-backend.onrender.com";

async function sendEmailResend({ to, subject, html }) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY no configurada");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to,
      subject,
      html,
    }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(msg);
  }

  return data; // { id: ... }
}

/* ---------------- CONFIG ---------------- */

const MAX_NUMBER = 200000;
const DB_FILE = "tickets.json";

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

/* ---------------- GENERADOR ---------------- */

function generateTickets(db, qty) {
  qty = Number(qty) || 0;
  if (qty <= 0) return [];

  const maxStart = MAX_NUMBER - qty;
  if (maxStart <= 0) return [];

  const usedSet = new Set(db.used);

  let start;
  let valid = false;

  while (!valid) {
    start = Math.floor(Math.random() * maxStart);
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

/* ---------------- HELPERS ---------------- */

function calcQtyFromLineItems(order) {
  let qty = 0;
  (order.line_items || []).forEach((item) => {
    const price = parseFloat(String(item.price || "").replace(",", "."));
    if (price === 1000) qty += 1;
    if (price === 3000) qty += 5;
    if (price === 5000) qty += 10;
  });
  return qty;
}

/* ---------------- WEBHOOK ---------------- */

app.post("/webhook", async (req, res) => {
  const order = req.body;

  const orderNumber = order?.order_number; // ej 1023
  const orderId = order?.id; // id interno Shopify
  const email = order?.email || null;

  console.log("🧾 Pedido recibido:", orderNumber);

  if (!orderNumber || !orderId) {
    return res.status(400).send({ error: "Order inválida (sin order_number o id)" });
  }

  // 1) Generación + guardado IDEMPOTENTE con lock
  const { tickets } = await withLock(async () => {
    const db = getDB();

    // ✅ Si ya existe la orden, devolvemos lo mismo (NO regenerar)
    if (db.orders[orderNumber]?.tickets?.length) {
      console.log("♻️ Orden repetida, devolviendo mismos tickets");
      return { tickets: db.orders[orderNumber].tickets };
    }

    const qty = calcQtyFromLineItems(order);

    // Guardamos aunque qty sea 0 para bloquear reintentos
    const ticketsNew = qty > 0 ? generateTickets(db, qty) : [];

    db.orders[orderNumber] = {
      tickets: ticketsNew,
      email,
      shopifyOrderId: orderId,
      createdAt: new Date().toISOString(),
      emailSent: false,
    };

    saveDB(db);

    console.log("🔥 Tickets generados:", ticketsNew);
    return { tickets: ticketsNew };
  });

  // 2) EMAIL (idempotente: solo si NO se envió antes)
  try {
    if (email && tickets.length > 0) {
      const shouldSend = await withLock(async () => {
        const db = getDB();
        if (!db.orders[orderNumber]) return false;

        if (db.orders[orderNumber].emailSent) {
          console.log("✉️ Email ya estaba enviado para esta orden, no reenviando");
          return false;
        }

        // marcamos ANTES de enviar para evitar doble envío si hay 2 webhooks
        db.orders[orderNumber].emailSent = true;
        saveDB(db);
        return true;
      });

      if (shouldSend) {
        const link = `${PUBLIC_BASE_URL}/tickets?order=${orderNumber}`;

        await sendEmailResend({
          to: email,
          subject: "🎟️ Tus números de rifa",
          html: `
            <h2>Gracias por tu compra</h2>
            <p>Estos son tus números:</p>
            <h3>${tickets.join(", ")}</h3>
            <p>Mucha suerte 🍀</p>
            <p>Ver tickets online:</p>
            <a href="${link}">Ver mis tickets online</a>
          `,
        });

        console.log("📧 Email enviado (Resend) a", email);
      }
    }
  } catch (err) {
    console.log("❌ Error enviando email (Resend):", err.message);

    // Si falló el envío, desmarcamos emailSent para reintentar
    await withLock(async () => {
      const db = getDB();
      if (db.orders[orderNumber]) {
        db.orders[orderNumber].emailSent = false;
        saveDB(db);
      }
    });
  }

  // 3) SHOPIFY (opcional)
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
        }
      );
      console.log("✅ Tickets guardados en Shopify");
    } else {
      console.log("ℹ️ Shopify env vars no configuradas, saltando guardado en Shopify");
    }
  } catch (err) {
    console.log("❌ Error guardando en Shopify:", err.response?.data || err.message);
  }

  return res.status(200).send({ tickets });
});

/* ---------------- SERVER ---------------- */

app.get("/", (req, res) => {
  res.send("Servidor activo");
});

app.get("/tickets", (req, res) => {
  const orderNumber = String(req.query.order || "").trim();
  const db = getDB();

  if (!orderNumber) return res.send("Orden no especificada");

  if (!db.orders || !db.orders[orderNumber]) {
    return res.send("No se encontraron tickets");
  }

  const data = db.orders[orderNumber];
  const tickets = data.tickets || [];

  if (!tickets.length) return res.send("No se encontraron tickets");

  res.send(`
    <h1>Tus números de rifa</h1>
    <p><b>Orden:</b> ${orderNumber}</p>
    <h2>${tickets.join(", ")}</h2>
  `);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});


const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const nodemailer = require("nodemailer");

const app = express();
app.use(bodyParser.json());

/* ---------------- EMAIL ---------------- */

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

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
    // Si el JSON se corrompe, lo recuperamos
    return ensureDBShape({ used: [], orders: {} });
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(ensureDBShape(db), null, 2));
}

/* ---------------- SIMPLE LOCK ---------------- */
// Para evitar que 2 webhooks al mismo tiempo generen números repetidos
let writing = false;
async function withLock(fn) {
  while (writing) {
    await new Promise(r => setTimeout(r, 50));
  }
  writing = true;
  try {
    return await fn();
  } finally {
    writing = false;
  }
}

/* ---------------- GENERADOR ---------------- */

function generateTickets(db, qty) {
  let start;
  let valid = false;

  // Seguridad: no permitir qty raro
  qty = Number(qty) || 0;
  if (qty <= 0) return [];

  // Evitar loop infinito si se agota el rango
  const maxStart = MAX_NUMBER - qty;
  if (maxStart <= 0) return [];

  // Set para buscar rápido (mucho más rápido que includes)
  const usedSet = new Set(db.used);

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

/* ---------------- WEBHOOK ---------------- */

app.post("/webhook", async (req, res) => {
  const order = req.body;

  const orderNumber = order?.order_number;
  const orderId = order?.id;

  console.log("🧾 Pedido recibido:", orderNumber);

  if (!orderNumber || !orderId) {
    return res.status(400).send({ error: "Order inválida (sin order_number o id)" });
  }

  // Todo lo crítico con lock para evitar duplicados por concurrencia
  const result = await withLock(async () => {
    const db = getDB();

    // ✅ IDEMPOTENCIA REAL: si ya existe, NO generar de nuevo
    if (db.orders[orderNumber]?.tickets?.length) {
      console.log("♻️ Orden repetida, devolviendo mismos tickets");
      return { db, tickets: db.orders[orderNumber].tickets, alreadyExisted: true };
    }

    // Calcular qty
    let qty = 0;
    (order.line_items || []).forEach(item => {
      const price = Number(String(item.price || "").replace(",", ".")); // por si viene raro
      if (price === 1000) qty += 1;
      if (price === 3000) qty += 5;
      if (price === 5000) qty += 10;
    });

    if (qty <= 0) {
      // Guardamos igual la orden para que si Shopify reintenta no haga nada
      db.orders[orderNumber] = {
        tickets: [],
        email: order.email || null,
        shopifyOrderId: orderId,
        createdAt: new Date().toISOString(),
        emailSent: false
      };
      saveDB(db);
      return { db, tickets: [], alreadyExisted: false };
    }

    const tickets = generateTickets(db, qty);

    db.orders[orderNumber] = {
      tickets,
      email: order.email || null,
      shopifyOrderId: orderId,
      createdAt: new Date().toISOString(),
      emailSent: false
    };

    saveDB(db);

    console.log("🔥 Tickets generados:", tickets);
    return { db, tickets, alreadyExisted: false };
  });

  const { db, tickets } = result;

  /* ---------- EMAIL (solo si no se ha enviado antes) ---------- */

  try {
    const email = order.email;

    if (email && tickets.length > 0) {
      // evitar re-envíos si el webhook se repite
      if (!db.orders[orderNumber].emailSent) {
        await transporter.sendMail({
          from: `"Rifas Jean" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: "🎟️ Tus números de rifa",
          html: `
            <h2>Gracias por tu compra</h2>
            <p>Estos son tus números:</p>
            <h3>${tickets.join(", ")}</h3>
            <p>Mucha suerte 🍀</p>
            <p>También puedes ver tus tickets aquí:</p>
            <a href="https://rifas-jean-backend.onrender.com/tickets?order=${orderNumber}">
              Ver mis tickets online
            </a>
          `
        });

        // marcar enviado con lock
        await withLock(async () => {
          const db2 = getDB();
          if (db2.orders[orderNumber]) {
            db2.orders[orderNumber].emailSent = true;
            saveDB(db2);
          }
        });

        console.log("📧 Email enviado a", email);
      } else {
        console.log("✉️ Email ya estaba enviado para esta orden, no reenviando");
      }
    }
  } catch (err) {
    console.log("❌ Error enviando email:", err.message);
  }

  /* ---------- SHOPIFY (opcional, solo si tienes variables bien) ---------- */

  try {
    // Si no están las env vars, no intentes
    if (process.env.SHOPIFY_STORE && process.env.SHOPIFY_ACCESS_TOKEN) {
      await axios.put(
        `https://${process.env.SHOPIFY_STORE}/admin/api/2023-10/orders/${orderId}.json`,
        {
          order: {
            id: orderId,
            note: "🎟️ Tickets: " + tickets.join(", "),
            note_attributes: [
              { name: "Tickets", value: tickets.join(", ") }
            ],
            tags: "rifa, tickets-generados"
          }
        },
        {
          headers: {
            "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
            "Content-Type": "application/json"
          }
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

  if (!tickets.length) {
    return res.send("No se encontraron tickets");
  }

  res.send(`
    <h1>Tus números de rifa</h1>
    <p><b>Orden:</b> ${orderNumber}</p>
    <p><b>Email:</b> ${data.email || "-"}</p>
    <h2>${tickets.join(", ")}</h2>
  `);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});

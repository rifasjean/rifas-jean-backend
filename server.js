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

/* ---------------- DB ---------------- */

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ used: [] }));
}

function getDB() {
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data));
}

/* ---------------- GENERADOR ---------------- */

function generateTickets(qty) {
  const db = getDB();
  let start;
  let valid = false;

  while (!valid) {
    start = Math.floor(Math.random() * (MAX_NUMBER - qty));
    valid = true;

    for (let i = 0; i < qty; i++) {
      if (db.used.includes(start + i)) {
        valid = false;
        break;
      }
    }
  }

  const tickets = [];

  for (let i = 0; i < qty; i++) {
    tickets.push(start + i);
    db.used.push(start + i);
  }

  saveDB(db);
  return tickets;
}

/* ---------------- WEBHOOK ---------------- */

app.post("/webhook", async (req, res) => {

  const order = req.body;

  console.log("🧾 Pedido recibido:", order.order_number);

  let qty = 0;

  order.line_items.forEach(item => {
    const price = parseFloat(item.price);
    if (price === 1000) qty += 1;
    if (price === 3000) qty += 5;
    if (price === 5000) qty += 10;
  });

  const tickets = generateTickets(qty);
const orderNumber = order.order_number;

const db = getDB();
db.orders = db.orders || {};

db.orders[orderNumber] = {
  tickets,
  email: order.email
};

saveDB(db);

  console.log("🔥 Tickets generados:", tickets);

  /* ---------- EMAIL ---------- */

  try {
    if (order.email && tickets.length > 0) {
      await transporter.sendMail({
        from: `"Rifas Jean" <${process.env.EMAIL_USER}>`,
        to: order.email,
        subject: "🎟️ Tus números de rifa",
        html: `
  <h2>Gracias por tu compra</h2>
  <p>Estos son tus números:</p>
  <h3>${tickets.join(", ")}</h3>
  <p>Mucha suerte 🍀</p>

  <p>También puedes ver tus tickets aquí:</p>

  <a href="https://rifas-jean-backend.onrender.com/tickets?order=${order.order_number}">
    Ver mis tickets online
  </a>
        `
      });

      console.log("📧 Email enviado a", order.email);
    }
  } catch (err) {
    console.log("❌ Error enviando email:", err.message);
  }

  /* ---------- GUARDAR EN SHOPIFY ---------- */

  try {

    await axios.put(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2023-10/orders/${order.id}.json`,
      {
        order: {
          id: order.id,

          /* 👇 ESTO ES LO IMPORTANTE */
          note: "🎟️ Tickets: " + tickets.join(", "),

          note_attributes: [
            {
              name: "Tickets",
              value: tickets.join(", ")
            }
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

  } catch (err) {
    console.log("❌ Error guardando en Shopify:", err.response?.data || err.message);
  }

  res.status(200).send({ tickets });
});

/* ---------------- SERVER ---------------- */

app.get("/", (req, res) => {
  res.send("Servidor activo");
});

const PORT = process.env.PORT || 10000;

app.get("/tickets", (req, res) => {
  const order = req.query.order;
  const db = getDB();

  if (!db.orders || !db.orders[order]) {
    return res.send("No se encontraron tickets");
  }

  const tickets = db.orders[order].tickets;

  res.send(`
    <h1>Tus números de rifa</h1>
    <h2>${tickets.join(", ")}</h2>
  `);
});

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});

const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const app = express();

app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("Servidor activo");
});

const MAX_NUMBER = 200000;
const DB_FILE = "tickets.json";

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ used: [] }));
}

function getDB() {
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data));
}

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

app.post("/webhook", async (req, res) => {
  const order = req.body;

  console.log("🧾 Pedido recibido:");
  console.log(JSON.stringify(order, null, 2));

  let qty = 0;

order.line_items.forEach(item => {

  const price = parseFloat(item.price);

  if (price === 1000) qty += 1;
  if (price === 3000) qty += 5;
  if (price === 5000) qty += 10;

});

  const tickets = generateTickets(qty);

  console.log("🔥 Tickets generados:", tickets);
// CAMBIAR NÚMERO DE PEDIDO EN SHOPIFY
try {
  await axios.put(
    `https://${process.env.SHOPIFY_STORE}/admin/api/2023-10/orders/${order.id}.json`,
    {
      order: {
  id: order.id,
  note: "Tickets: " + tickets.join(", "),
  name: `RJ-${order.order_number}-${Math.floor(Math.random()*900+100)}`
}
    },
    {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("✅ Pedido renombrado");
} catch (err) {
  console.log("⚠️ No se pudo renombrar pedido");
}

  res.status(200).send({ tickets });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});

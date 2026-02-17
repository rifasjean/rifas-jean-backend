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

app.post("/webhook", (req, res) => {
  const order = req.body;

  let qty = 0;

  order.line_items.forEach(item => {
    if (item.title.includes("1 Ticket")) qty += 1;
    if (item.title.includes("5 Tickets")) qty += 5;
    if (item.title.includes("10 Tickets")) qty += 10;
  });

  const tickets = generateTickets(qty);

  console.log("🔥 Tickets generados:", tickets);

  res.status(200).send({ tickets });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});

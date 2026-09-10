// Server/scripts/seedSuperAdmin.js
// ─────────────────────────────────────────────────────────────────────────────
// Creates (or promotes) the Super Admin account. Run once from your Server
// folder — same folder as server.js:
//
//   node scripts/seedSuperAdmin.js
//
// This does NOT import server.js (that would also boot the whole Express app
// and start listening on a port just to run a script). Instead it defines
// its own copy of the User schema — matching server.js's UserSchema field
// for field, including the same pre-save bcrypt hook — and connects to the
// same MongoDB database via MONGO_URI. Mongoose models are just a typed view
// over a MongoDB collection, so this writes into the exact same `users`
// collection server.js reads from; nothing about this is a separate store.
//
// Safe to re-run any time: if the account already exists, it just makes sure
// role is 'admin' and status is 'active', and leaves the password alone
// unless SUPERADMIN_RESET_PASSWORD=true is set.
//
// Prefer environment variables over editing this file, so the real password
// never sits in your codebase or git history:
//   SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD, MONGO_URI
// The values below are only a fallback for a quick first run.
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");

const EMAIL    = process.env.SUPERADMIN_EMAIL    || "waleedasjadltd@gmail.com";
const PASSWORD = process.env.SUPERADMIN_PASSWORD || "SPHaval#586";
const NAME     = process.env.SUPERADMIN_NAME     || "Super Admin";
const RESET_PASSWORD = process.env.SUPERADMIN_RESET_PASSWORD === "true";

// Mirrors UserSchema in server.js exactly (only the fields that matter for
// auth are required here — Mongoose fills the rest with schema defaults).
const UserSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6 },
  role:     { type: String, enum: ["student", "instructor", "admin"], default: "student" },
  status:   { type: String, enum: ["active", "suspended"], default: "active" },
}, { timestamps: true, strict: false }); // strict:false so it coexists with the fuller schema's extra fields

UserSchema.pre("save", async function (next) {
  if (this.isModified("password")) this.password = await bcrypt.hash(this.password, 10);
  next();
});

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("MONGO_URI is not set. Add it to your Server .env file.");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB.");

  const User = mongoose.model("User", UserSchema);
  let admin = await User.findOne({ email: EMAIL.toLowerCase().trim() });

  if (admin) {
    let changed = false;
    if (admin.role !== "admin")    { admin.role = "admin";     changed = true; }
    if (admin.status !== "active") { admin.status = "active";  changed = true; }
    if (RESET_PASSWORD) {
      admin.password = PASSWORD; // pre-save hook hashes this on .save()
      changed = true;
      console.log("Password will be reset for the existing account.");
    }
    if (changed) {
      await admin.save();
      console.log(`Updated existing user ${EMAIL} → role: admin.`);
    } else {
      console.log(`${EMAIL} is already a super admin. Nothing to change.`);
      console.log("(Set SUPERADMIN_RESET_PASSWORD=true to also reset the password.)");
    }
  } else {
    admin = await User.create({
      name: NAME,
      email: EMAIL.toLowerCase().trim(),
      password: PASSWORD, // pre-save hook hashes this before it touches the DB
      role: "admin",
      status: "active",
    });
    console.log(`Created super admin account: ${EMAIL}`);
  }

  await mongoose.disconnect();
  console.log("Done. Log in from the normal login page with these credentials —");
  console.log("the app will route you to /superadmin automatically based on role.");
  process.exit(0);
}

run().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Router } from "express";
import AppUser from "../db/models/User.js";
import { isDBConnected } from "../db/connection.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-secret-change-me";
const JWT_EXPIRES = "24h";

export const jwtAuthRouter = Router();

jwtAuthRouter.post("/signup", async (req, res) => {
  if (!isDBConnected()) return res.status(503).json({ error: "Database not connected" });
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });
  try {
    const existing = await AppUser.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: "User already exists" });
    const hashed = await bcrypt.hash(password, 10);
    const user = await AppUser.create({ email: email.toLowerCase(), password: hashed, name: name || "" });
    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.status(201).json({ ok: true, token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

jwtAuthRouter.post("/login", async (req, res) => {
  if (!isDBConnected()) return res.status(503).json({ error: "Database not connected" });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });
  try {
    const user = await AppUser.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    user.lastLoginAt = new Date();
    await user.save();
    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ ok: true, token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

jwtAuthRouter.get("/me", (req, res) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ ok: true, userId: decoded.userId, email: decoded.email });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

export function optionalAuth(req, _res, next) {
  const token = extractToken(req);
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.appUserId = decoded.userId;
      req.appUserEmail = decoded.email;
    } catch { /* proceed without auth */ }
  }
  next();
}

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return req.query?.token || null;
}

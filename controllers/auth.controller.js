// server/controllers/auth.controller.js
// ─── Register + Login logic ───────────────────────────────────────────────────

const jwt = require("jsonwebtoken");
const User = require("../models/User.model");

// ── Helper: generate JWT token ────────────────────────────────────────────────
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });
};

// ── Helper: build safe user response (no password) ───────────────────────────
const userResponse = (user, token) => ({
  token,
  user: {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    bio: user.bio,
    title: user.title,
    avatar: user.avatar,
  },
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
const register = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Validate required fields
    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required." });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered. Please login." });
    }

    // Only allow "student" or "instructor" roles
    const allowedRoles = ["student", "instructor"];
    const userRole = allowedRoles.includes(role) ? role : "student";

    // Create user (password is hashed automatically in the model)
    const user = await User.create({ name, email, password, role: userRole });

    const token = generateToken(user._id);

    res.status(201).json({
      message: "Registration successful!",
      ...userResponse(user, token),
    });
  } catch (error) {
    console.error("Register error:", error.message);
    res.status(500).json({ message: "Server error during registration." });
  }
};

// ── POST /api/auth/login ──────────────────────────────────────────────────────
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    // Check password
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const token = generateToken(user._id);

    res.status(200).json({
      message: "Login successful!",
      ...userResponse(user, token),
    });
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(500).json({ message: "Server error during login." });
  }
};

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Returns the currently logged-in user's info
const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    res.status(200).json({ user });
  } catch (error) {
    res.status(500).json({ message: "Could not fetch user." });
  }
};

module.exports = { register, login, getMe };

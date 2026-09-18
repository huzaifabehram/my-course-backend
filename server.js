// Server/server.js — Complete MERN Backend
// ✅ Compatible with: imageTestimonials, videoTestimonials, projectGallery,
//    alsoBoughtCourseIds from InstructorDashboard
// ✅ Cloudinary image + video upload via streams (no disk storage needed)
// ✅ Video testimonial upload via POST /api/upload/video
// ✅ All new course fields saved & returned to Shopify.jsx landing page
require("dotenv").config();

const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");
const multer   = require("multer");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const cloudinary = require("cloudinary").v2;
const crypto      = require("crypto"); // used to hash payment screenshots (fraud/dedup check below)

const app = express();

// ─── CLOUDINARY CONFIG ────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
console.log("☁️  Cloudinary:", process.env.CLOUDINARY_CLOUD_NAME ? "✓ configured" : "✗ NOT configured — set env vars");

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://motiviam.com",
  "https://www.motiviam.com",
  process.env.CLIENT_URL,
  process.env.PUBLIC_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ─── MONGODB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err.message));
mongoose.connection.on("disconnected", () => console.log("⚠️  MongoDB disconnected"));
mongoose.connection.on("reconnected",  () => console.log("✅ MongoDB reconnected"));

// ══════════════════════════════════════════════════════════════════════════════
// SCHEMAS & MODELS
// ══════════════════════════════════════════════════════════════════════════════

// ── User ──────────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6 },
  role:     { type: String, enum: ["student","instructor","admin"], default: "student" },
  status:   { type: String, enum: ["active","suspended"], default: "active" },
  avatar:   String,
  bio:      String,
  title:    String,
  location: String,
  website:  String,
  twitter:  String,
  linkedin: String,
  // Instructor display stats (manually set — not auto-calculated)
  totalRatings:        { type: Number, default: 0 },
  totalReviews:        { type: Number, default: 0 },
  totalStudents:       { type: Number, default: 0 },
  totalCourses:        { type: Number, default: 0 },
  instructorDescription: { type: String, default: "" },
  // FIX: the Instructor Dashboard's Profile → Description page saves an
  // ordered list of paragraph/photo/video blocks here. This field was
  // completely missing from the schema, so Mongoose (strict mode, the
  // default) silently dropped it on every save — that's the "picture/video
  // disappears right after Save Changes" bug. Mixed (not a strict
  // sub-schema) because the three block shapes (text / image / video) don't
  // share the same fields.
  instructorDescriptionBlocks: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });

UserSchema.pre("save", async function(next) {
  if (this.isModified("password")) this.password = await bcrypt.hash(this.password, 10);
  next();
});
UserSchema.methods.matchPassword = function(plain) {
  return bcrypt.compare(plain, this.password);
};
const User = mongoose.model("User", UserSchema);

// ── Sub-document schemas ──────────────────────────────────────────────────────
const LectureSchema = new mongoose.Schema({
  _id:       { type: mongoose.Schema.Types.Mixed },
  title:     { type: String, default: "Untitled Lecture" },
  type:      { type: String, default: "video" },
  duration:  { type: String, default: "" },
  free:      { type: Boolean, default: false },
  preview:   { type: Boolean, default: false },
  videoUrl:  { type: String, default: "" },
  resources: [String],
}, { _id: false });

const SectionSchema = new mongoose.Schema({
  _id:      { type: mongoose.Schema.Types.Mixed },
  title:    { type: String, default: "Untitled Section" },
  lectures: { type: [LectureSchema], default: [] },
}, { _id: false });

// ── NEW: testimonial + gallery sub-schemas ────────────────────────────────────
const ImageTestimonialSchema = new mongoose.Schema({
  author:   { type: String, default: "" },
  text:     { type: String, default: "" },
  imageUrl: { type: String, default: "" },
}, { _id: true });

const VideoTestimonialSchema = new mongoose.Schema({
  author:   { type: String, default: "" },
  text:     { type: String, default: "" },
  videoUrl: { type: String, default: "" },
}, { _id: true });

const ProjectGallerySchema = new mongoose.Schema({
  caption:  { type: String, default: "" },
  imageUrl: { type: String, default: "" },
}, { _id: true });

// ── Course ────────────────────────────────────────────────────────────────────
const CourseSchema = new mongoose.Schema({
  title:            { type: String, required: true, trim: true },
  subtitle:         String,
  description:      String,
  category:         String,
  price:            { type: Number, default: 0, min: 0 },
  discountPrice:    { type: Number, min: 0 },
  originalPrice:    { type: Number, min: 0 },
  thumbnail:        String,
  previewVideoUrl:  String,
  tags:             [String],
  whatYouLearn:     [String],
  requirements:     [String],
  status:           { type: String, enum: ["draft","published","review"], default: "draft" },
  instructor:       { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  sections:         { type: [SectionSchema], default: [] },
  rating:           { type: Number, default: 0 },
  totalRatings:     { type: Number, default: 0 },
  reviews:          { type: Number, default: 0 },
  studentsEnrolled: { type: Number, default: 0 },
  students:         { type: Number, default: 0 },
  revenue:          { type: Number, default: 0 },
  badge:            String,
  bestseller:       { type: Boolean, default: false },
  level:            { type: String, default: "Beginner" },
  language:         { type: String, default: "English" },
  duration:         String,
  lastUpdated:      String,
  // ── NEW fields (saved from InstructorDashboard) ───────────────────────────
  imageTestimonials:   { type: [ImageTestimonialSchema],   default: [] },
  videoTestimonials:   { type: [VideoTestimonialSchema],   default: [] },
  projectGallery:      { type: [ProjectGallerySchema],     default: [] },
  alsoBoughtCourseIds: {
    type:    [{ type: mongoose.Schema.Types.ObjectId, ref: "Course" }],
    default: [],
  },
}, { timestamps: true });
const Course = mongoose.model("Course", CourseSchema);

// ── Enrollment ────────────────────────────────────────────────────────────────
const EnrollmentSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User",   required: true },
  course:  { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },
  // ── NEW: captured on the Enrollment page (Step 1 + Step 2) ────────────────
  whatsapp:      { type: String, default: "" },
  paymentMethod: { type: String, enum: ["bank", "jazzcash", "easypaisa", "card", ""], default: "" },
  paymentScreenshotUrl: { type: String, default: "" },
  paymentStatus: { type: String, enum: ["pending", "verified", "rejected"], default: "pending" },
  // ── NEW: Super Admin verification ──────────────────────────────────────
  amount:          { type: Number, default: 0 },     // PKR price shown to the student at checkout
  currency:        { type: String, default: "PKR" },
  rejectionReason: { type: String, default: "" },
  verifiedBy:      { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  verifiedAt:      { type: Date },
}, { timestamps: true });
EnrollmentSchema.index({ student: 1, course: 1 }, { unique: true });
const Enrollment = mongoose.model("Enrollment", EnrollmentSchema);

// ── Progress ──────────────────────────────────────────────────────────────────
const ProgressSchema = new mongoose.Schema({
  student:           { type: mongoose.Schema.Types.ObjectId, ref: "User",   required: true },
  courseId:          { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },
  completedLectures: { type: [String], default: [] },
}, { timestamps: true });
ProgressSchema.index({ student: 1, courseId: 1 }, { unique: true });
const Progress = mongoose.model("Progress", ProgressSchema);

// ── Notes — per-student, per-lecture timestamped notes (Student Portal) ────
const NoteSchema = new mongoose.Schema({
  student:   { type: mongoose.Schema.Types.ObjectId, ref: "User",   required: true },
  courseId:  { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },
  lectureId: { type: String, required: true },
  lectureTitle: { type: String, default: "" }, // snapshot, so a note still reads sensibly if a lecture is later renamed/removed
  content:   { type: String, required: true, trim: true },
}, { timestamps: true });
const Note = mongoose.model("Note", NoteSchema);

// ── Q&A — per-course questions with embedded answers (Student Portal) ──────
const AnswerSchema = new mongoose.Schema({
  author:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  text:      { type: String, required: true, trim: true },
}, { timestamps: true });
const QuestionSchema = new mongoose.Schema({
  author:    { type: mongoose.Schema.Types.ObjectId, ref: "User",   required: true },
  courseId:  { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },
  lectureId: { type: String, default: "" },
  lectureTitle: { type: String, default: "" },
  text:      { type: String, required: true, trim: true },
  upvotes:   { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], default: [] },
  answers:   { type: [AnswerSchema], default: [] },
}, { timestamps: true });
const Question = mongoose.model("Question", QuestionSchema);

// ── Review ────────────────────────────────────────────────────────────────────
const ReviewSchema = new mongoose.Schema({
  course:     { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },
  student:    { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // optional — guest reviews allowed
  authorName: { type: String, default: "" },
  rating:     { type: Number, required: true, min: 1, max: 5 },
  comment:    { type: String, default: "" },
  text:       { type: String, default: "" },
}, { timestamps: true });
const Review = mongoose.model("Review", ReviewSchema);

// Drop legacy one-review-per-student index (allows unlimited guest + member reviews)
mongoose.connection.once("open", async () => {
  try {
    await Review.collection.dropIndex("course_1_student_1");
    console.log("✓ Dropped legacy unique review index");
  } catch {
    /* index may not exist */
  }
});

// ── Site Settings — singleton document (logo, etc.) ────────────────────────────
// Only ever one document. Set from Super Admin Dashboard → Settings, read
// publicly by every page that needs to render the site logo (course pages,
// footer, etc).
const SiteSettingsSchema = new mongoose.Schema({
  logoUrl: { type: String, default: "" },
  // NEW CHANGE AK: second, independent logo slot — the header logo (logoUrl)
  // was originally reused in the footer too, which looked wrong on the dark
  // brown footer background if the header logo has a white backdrop. Now the
  // footer can have its own uploaded image, separate from the header's.
  footerLogoUrl: { type: String, default: "" },
  // NEW: payment-method logos shown on the Enrollment page (Bank Transfer's
  // two banks, JazzCash, Easypaisa) — uploaded from Super Admin → Settings,
  // same as the header/footer logo, instead of being bundled as static
  // image files the developer has to place by hand.
  paymentLogoUbl:       { type: String, default: "" },
  paymentLogoAllied:    { type: String, default: "" },
  paymentLogoJazzcash:  { type: String, default: "" },
  paymentLogoEasypaisa: { type: String, default: "" },
}, { timestamps: true });
const SiteSettings = mongoose.model("SiteSettings", SiteSettingsSchema);

async function getSiteSettings() {
  // findOneAndUpdate with upsert makes "get the settings doc, creating it if
  // it doesn't exist yet" a single atomic operation, instead of the earlier
  // find-then-create-if-missing pattern (which could race and create two
  // separate documents if a request landed at just the wrong moment).
  // Sorting by _id (ascending) makes the choice deterministic if more than
  // one such document already exists from before this fix.
  //
  // IMPORTANT: $setOnInsert must not be an empty object — MongoDB rejects
  // that with "'$setOnInsert' is empty" and the whole call throws. An
  // earlier version of this fix passed {} here, which broke EVERY call to
  // getSiteSettings() (both the GET /api/settings every page uses, and the
  // logo upload route) — this is what made the logo stop showing up
  // anywhere at all, not just the footer. Passing the schema's own defaults
  // here keeps the upsert meaningful without that error.
  return SiteSettings.findOneAndUpdate(
    {},
    { $setOnInsert: {
        logoUrl: "", footerLogoUrl: "",
        paymentLogoUbl: "", paymentLogoAllied: "", paymentLogoJazzcash: "", paymentLogoEasypaisa: "",
      } },
    { new: true, upsert: true, sort: { _id: 1 } }
  );
}

// ── Contact Us submissions — from the public Contact Us page ───────────────────
const ContactSubmissionSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  email:   { type: String, required: true, trim: true, lowercase: true },
  message: { type: String, required: true, trim: true },
  status:  { type: String, enum: ["new", "read"], default: "new" },
}, { timestamps: true });
const ContactSubmission = mongoose.model("ContactSubmission", ContactSubmissionSchema);

// ── Newsletter subscribers — from the footer newsletter box ────────────────────
const NewsletterSubscriberSchema = new mongoose.Schema({
  email: { type: String, required: true, trim: true, lowercase: true, unique: true },
}, { timestamps: true });
const NewsletterSubscriber = mongoose.model("NewsletterSubscriber", NewsletterSubscriberSchema);

// ── Payment screenshot hashes — fraud prevention ────────────────────────────
// Stores a SHA-256 hash of every payment screenshot that's ever been
// submitted (see POST /api/upload/payment-screenshot below). Before
// accepting a new screenshot we hash it and check this collection — if the
// exact same image file has been submitted before (by anyone, for any
// course), the upload is rejected. This stops one payment screenshot being
// reused to "confirm" more than one enrollment. A different screenshot from
// the same person is unaffected — only an exact repeat of the same file.
const PaymentScreenshotHashSchema = new mongoose.Schema({
  hash:     { type: String, required: true, unique: true, index: true },
  courseId: { type: String, default: "" },
  url:      { type: String, default: "" }, // the Cloudinary URL it resolved to, for admin lookup
}, { timestamps: true });
const PaymentScreenshotHash = mongoose.model("PaymentScreenshotHash", PaymentScreenshotHashSchema);

// ══════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════════

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });

const protect = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Not authorized — no token provided" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");
    if (!req.user) return res.status(401).json({ message: "User not found" });
    if (req.user.status === "suspended")
      return res.status(403).json({ message: "This account has been suspended." });
    next();
  } catch {
    res.status(401).json({ message: "Token is invalid or expired" });
  }
};

// Attach user when a valid token is present; guests proceed without auth
const optionalProtect = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");
  } catch { /* invalid token — treat as guest */ }
  next();
};

const instructorOnly = (req, res, next) => {
  if (req.user?.role !== "instructor")
    return res.status(403).json({ message: "Access denied — instructors only" });
  next();
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin")
    return res.status(403).json({ message: "Access denied — super admin only" });
  next();
};

function serializeUser(user) {
  if (!user) return null;
  return {
    _id:       user._id,
    name:      user.name,
    email:     user.email,
    role:      user.role,
    status:    user.status    || "active",
    avatar:    user.avatar    || "",
    bio:       user.bio       || "",
    title:     user.title     || "",
    location:  user.location  || "",
    website:   user.website   || "",
    twitter:   user.twitter   || "",
    linkedin:  user.linkedin  || "",
    totalRatings:          Number(user.totalRatings)  || 0,
    totalReviews:          Number(user.totalReviews)  || 0,
    totalStudents:         Number(user.totalStudents) || 0,
    totalCourses:          Number(user.totalCourses)  || 0,
    instructorDescription: user.instructorDescription || "",
    // FIX: this was never included in the response, so even once the field
    // above is actually saved to MongoDB, the frontend's `user` object never
    // received it back — login, GET /api/auth/me, and the profile-save
    // response would all silently strip it, which looks identical to "it
    // didn't save." Now it round-trips properly.
    instructorDescriptionBlocks: Array.isArray(user.instructorDescriptionBlocks) ? user.instructorDescriptionBlocks : [],
    createdAt: user.createdAt,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/** Stream a Buffer directly to Cloudinary — no temp files needed */
function streamToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

/** Guard: reject upload if Cloudinary env vars are missing */
function requireCloudinary(req, res, next) {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)
    return res.status(500).json({ message: "Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET to .env" });
  next();
}

/** Strip transient `id` keys added by the frontend before saving to MongoDB */
function stripFrontendIds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(({ id, ...rest }) => rest);   // remove `id`, keep `_id` if present
}

/** Fix sections + lectures coming from the frontend (may have `id` instead of `_id`) */
function sanitizeSections(body) {
  const data = { ...body };
  if (!Array.isArray(data.sections)) return data;
  data.sections = data.sections.map(section => {
    const sec = { ...section };
    if (!sec._id) sec._id = sec.id || new mongoose.Types.ObjectId().toString();
    delete sec.id;
    if (Array.isArray(sec.lectures)) {
      sec.lectures = sec.lectures.map(lec => {
        const l = { ...lec };
        if (!l._id) l._id = l.id || new mongoose.Types.ObjectId().toString();
        delete l.id;
        return l;
      });
    }
    return sec;
  });
  return data;
}

/** Sanitize the full course payload before create/update */
function sanitizeCoursePayload(raw) {
  const data = sanitizeSections(raw);

  // Strip frontend-only `id` from testimonials & gallery arrays
  if (data.imageTestimonials)   data.imageTestimonials   = stripFrontendIds(data.imageTestimonials);
  if (data.videoTestimonials)   data.videoTestimonials   = stripFrontendIds(data.videoTestimonials);
  if (data.projectGallery)      data.projectGallery      = stripFrontendIds(data.projectGallery);

  // alsoBoughtCourseIds — keep as-is (array of ObjectId strings)
  if (!Array.isArray(data.alsoBoughtCourseIds)) data.alsoBoughtCourseIds = [];

  return data;
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOT / HEALTH
// ══════════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => res.json({ status: "ok", message: "Learnify API 🚀", version: "2.0.0", timestamp: new Date().toISOString() }));

app.get("/api/health", (req, res) => res.json({
  status:     "ok",
  database:   mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  cloudinary: process.env.CLOUDINARY_CLOUD_NAME ? "configured" : "not configured",
  time:       new Date().toISOString(),
}));

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name?.trim() || !email?.trim() || !password)
      return res.status(400).json({ message: "Name, email and password are required" });
    if (password.length < 6)
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    if (await User.findOne({ email: email.toLowerCase().trim() }))
      return res.status(400).json({ message: "Email is already registered" });

    const user = await User.create({
      name:  name.trim(),
      email: email.toLowerCase().trim(),
      password,
      role:  role === "instructor" ? "instructor" : "student",
    });
    res.status(201).json({
      token: signToken(user._id),
      user:  serializeUser(user),
    });
  } catch (err) {
    console.error("Register error:", err.message);
    res.status(500).json({ message: "Registration failed." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password are required" });
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !(await user.matchPassword(password)))
      return res.status(401).json({ message: "Invalid email or password" });
    if (user.status === "suspended")
      return res.status(403).json({ message: "This account has been suspended. Contact support." });
    res.json({
      token: signToken(user._id),
      user:  serializeUser(user),
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ message: "Login failed." });
  }
});

app.get("/api/auth/me", protect, (req, res) => {
  res.json(serializeUser(req.user));
});

async function handleUpdateProfile(req, res) {
  try {
    // FIX: "instructorDescriptionBlocks" was missing from this whitelist, so
    // even with the schema fixed above, this route was throwing the field
    // away before it ever reached User.findByIdAndUpdate — the request
    // would still return 200 "saved successfully" while quietly discarding
    // the one field that matters. This was the second half of the
    // disappears-after-save bug (the User schema was the first half).
    const allowed = [
      "name", "bio", "title", "location", "website", "avatar", "twitter", "linkedin",
      "totalRatings", "totalReviews", "totalStudents", "totalCourses", "instructorDescription",
      "instructorDescriptionBlocks",
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        let value = req.body[key];
        if (key === "avatar" && value && !String(value).startsWith("http")) {
          continue;
        }
        if (key === "totalRatings") {
          const n = parseFloat(value);
          updates[key] = isNaN(n) ? 0 : Math.min(5, Math.max(0, Math.round(n * 10) / 10));
          continue;
        }
        if (["totalReviews", "totalStudents", "totalCourses"].includes(key)) {
          const n = parseInt(value, 10);
          updates[key] = isNaN(n) ? 0 : Math.max(0, n);
          continue;
        }
        if (key === "instructorDescriptionBlocks") {
          updates[key] = Array.isArray(value) ? value : [];
          continue;
        }
        updates[key] = value;
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No profile fields to update" });
    }
    const user = await User.findByIdAndUpdate(
      req.user._id,
      updates,
      { new: true, runValidators: true }
    ).select("-password");
    res.json(serializeUser(user));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

app.patch("/api/auth/profile", protect, handleUpdateProfile);

// ══════════════════════════════════════════════════════════════════════════════
// USER ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Named route MUST come before /:id — InstructorDashboard calls PUT /api/users/profile
app.put("/api/users/profile", protect, handleUpdateProfile);
app.patch("/api/users/profile", protect, handleUpdateProfile);

app.get("/api/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(serializeUser(user));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// COURSE ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Named sub-routes MUST come before /:id wildcard

app.get("/api/courses/instructor/my-courses", protect, instructorOnly, async (req, res) => {
  try {
    res.json(await Course.find({ instructor: req.user._id }).sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/courses/instructor/mine", protect, instructorOnly, async (req, res) => {
  try {
    res.json(await Course.find({ instructor: req.user._id }).sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/courses", async (req, res) => {
  try {
    const { category, search } = req.query;
    const query = { status: "published" };
    if (category && category !== "All") query.category = category;
    if (search) query.title = { $regex: search, $options: "i" };
    const courses = await Course.find(query)
      .populate("instructor", "name avatar title")
      .select("-sections")
      .sort("-createdAt");
    res.json(courses);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET single course — returns ALL new fields to Shopify.jsx ─────────────────
app.get("/api/courses/:id", async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate("instructor", "name avatar title bio location website twitter linkedin totalRatings totalReviews totalStudents totalCourses instructorDescription");
    if (!course) return res.status(404).json({ message: "Course not found" });

    // Fetch & format reviews
    const dbReviews = await Review.find({ course: req.params.id })
      .populate("student", "name avatar")
      .sort("-createdAt")
      .limit(50);

    const reviews_list = dbReviews.map(r => ({
      _id:        r._id,
      author:     r.authorName || r.student?.name || "Anonymous",
      authorName: r.authorName || r.student?.name || "",
      avatar:     r.student?.avatar || "",
      rating:     r.rating,
      text:       r.comment || r.text || "",
      date:       r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "Recently",
    }));

    // Add lectures_list to each section (Shopify.jsx reads `section.lectures_list`)
    const sectionsWithList = course.sections.map(sec => ({
      ...sec.toObject(),
      lectures_list: sec.lectures || [],
    }));

    const obj = course.toObject();
    res.json({
      ...obj,
      sections:            sectionsWithList,
      reviews_list,
      students:            obj.students || obj.studentsEnrolled || 0,
      reviews:             obj.reviews  || obj.totalRatings     || 0,
      // ── NEW fields passed through to landing page ──────────────────────
      imageTestimonials:   obj.imageTestimonials   || [],
      videoTestimonials:   obj.videoTestimonials   || [],
      projectGallery:      obj.projectGallery      || [],
      alsoBoughtCourseIds: obj.alsoBoughtCourseIds || [],
    });
  } catch (err) {
    console.error("GET course error:", err);
    res.status(404).json({ message: "Course not found" });
  }
});

app.post("/api/courses", protect, instructorOnly, async (req, res) => {
  try {
    const data = sanitizeCoursePayload(req.body);
    const course = await Course.create({ ...data, instructor: req.user._id });
    res.status(201).json(course);
  } catch (err) {
    console.error("CREATE COURSE ERROR:", err.message);
    res.status(400).json({ message: err.message });
  }
});

app.put("/api/courses/:id", protect, instructorOnly, async (req, res) => {
  try {
    const data = sanitizeCoursePayload(req.body);
    const course = await Course.findOneAndUpdate(
      { _id: req.params.id, instructor: req.user._id },
      data,
      { new: true, runValidators: false }
    );
    if (!course) return res.status(404).json({ message: "Course not found or unauthorized" });
    res.json(course);
  } catch (err) {
    console.error("UPDATE COURSE ERROR:", err.message);
    res.status(400).json({ message: err.message });
  }
});

app.delete("/api/courses/:id", protect, instructorOnly, async (req, res) => {
  try {
    const course = await Course.findOneAndDelete({ _id: req.params.id, instructor: req.user._id });
    if (!course) return res.status(404).json({ message: "Course not found or unauthorized" });
    res.json({ message: "Course deleted successfully" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.patch("/api/courses/:id/publish", protect, instructorOnly, async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.id, instructor: req.user._id });
    if (!course) return res.status(404).json({ message: "Course not found or unauthorized" });
    course.status = course.status === "published" ? "draft" : "published";
    await course.save();
    res.json({ status: course.status, isPublished: course.status === "published" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.patch("/api/courses/:id/status", protect, instructorOnly, async (req, res) => {
  try {
    const course = await Course.findOneAndUpdate(
      { _id: req.params.id, instructor: req.user._id },
      { status: req.body.status },
      { new: true }
    );
    if (!course) return res.status(404).json({ message: "Course not found" });
    res.json(course);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ENROLLMENT ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/enrollments/my", protect, async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ student: req.user._id })
      .populate({ path: "course", populate: { path: "instructor", select: "name avatar title" } })
      .sort("-createdAt");
    res.json(enrollments);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/enrollments/check/:courseId", protect, async (req, res) => {
  try {
    const enrollment = await Enrollment.findOne({ student: req.user._id, course: req.params.courseId });
    // "enrolled" now means verified access, not just "submitted a payment" —
    // consistent with the gating change below in POST /api/enrollments/:courseId.
    const hasAccess = Boolean(enrollment && enrollment.paymentStatus === "verified");
    res.json({
      enrolled: hasAccess,
      isEnrolled: hasAccess,
      status: enrollment ? enrollment.paymentStatus : null, // 'pending' | 'verified' | 'rejected' | null
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/enrollments/:courseId", protect, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ message: "Course not found" });
    if (course.status !== "published" && course.price > 0)
      return res.status(403).json({ message: "This course is not available for enrollment" });

    const existing = await Enrollment.findOne({ student: req.user._id, course: req.params.courseId });
    if (existing) return res.status(400).json({ message: "Already enrolled" });

    // ── NEW: WhatsApp number, chosen payment method, and payment screenshot
    // URL, from the Enrollment page (Step 1 + Step 2). All optional — enrollment
    // still works without them so this route stays backward compatible with
    // older callers.
    const { whatsapp, paymentMethod, paymentScreenshotUrl } = req.body || {};
    const validMethods = ["bank", "jazzcash", "easypaisa", "card"];

    const enrollment = await Enrollment.create({
      student: req.user._id,
      course:  req.params.courseId,
      whatsapp:      typeof whatsapp === "string" ? whatsapp.trim() : "",
      paymentMethod: validMethods.includes(paymentMethod) ? paymentMethod : "",
      paymentScreenshotUrl: typeof paymentScreenshotUrl === "string" ? paymentScreenshotUrl.trim() : "",
      // Snapshot of what the student was shown at checkout (Shopify.jsx /
      // EnrolledPage.jsx both display PKR = price * 280) — read by the
      // Super Admin verification queue.
      amount:   Math.round((course.price || 0) * 280),
      currency: "PKR",
    });

    // NOTE — behavior change: course access (the studentsEnrolled/students
    // count bump and the Progress record) used to be granted right here,
    // immediately on submission. It's now granted only once a super admin
    // verifies the payment screenshot — see
    // PATCH /api/admin/enrollments/:id/verify further down — so a student
    // can no longer reach paid content before their payment has actually
    // been checked. If you'd rather keep instant access and use the admin
    // panel purely as an audit trail, move the two calls that used to be
    // here (Course $inc + Progress upsert) back to this spot.

    res.status(201).json(enrollment);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SUPER ADMIN ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/admin/stats", protect, adminOnly, async (req, res) => {
  try {
    const [totalStudents, totalInstructors, totalCourses, pendingVerifications, allCourses] = await Promise.all([
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "instructor" }),
      Course.countDocuments({}),
      Enrollment.countDocuments({ paymentStatus: "pending" }),
      Course.find({}).select("revenue"),
    ]);
    const totalRevenue = allCourses.reduce((sum, c) => sum + (c.revenue || 0), 0);
    res.json({ totalStudents, totalInstructors, totalCourses, pendingVerifications, totalRevenue });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Alias — some frontend builds call this "/overview" instead of "/stats".
// Same handler, so whichever one the deployed dashboard actually calls works.
app.get("/api/admin/overview", protect, adminOnly, async (req, res) => {
  try {
    const [totalStudents, totalInstructors, totalCourses, pendingVerifications, allCourses] = await Promise.all([
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "instructor" }),
      Course.countDocuments({}),
      Enrollment.countDocuments({ paymentStatus: "pending" }),
      Course.find({}).select("revenue"),
    ]);
    const totalRevenue = allCourses.reduce((sum, c) => sum + (c.revenue || 0), 0);
    res.json({ totalStudents, totalInstructors, totalCourses, pendingVerifications, totalRevenue });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/students", protect, adminOnly, async (req, res) => {
  try {
    const students = await User.find({ role: "student" }).select("-password").sort("-createdAt");
    const enrollments = await Enrollment.find({}).populate("course", "title");

    const byStudent = {};
    for (const e of enrollments) {
      const sid = String(e.student);
      if (!byStudent[sid]) byStudent[sid] = [];
      byStudent[sid].push({
        _id: e._id,
        courseId: e.course?._id,
        courseTitle: e.course?.title || "Untitled course",
        status: e.paymentStatus,
        amount: e.amount,
        paymentMethod: e.paymentMethod,
        createdAt: e.createdAt,
      });
    }

    res.json(students.map((s) => ({
      ...s.toObject(),
      status: s.status || "active",
      enrollments: byStudent[String(s._id)] || [],
    })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/instructors", protect, adminOnly, async (req, res) => {
  try {
    const instructors = await User.find({ role: "instructor" }).select("-password").sort("-createdAt");
    const courses = await Course.find({});

    const byInstructor = {};
    for (const c of courses) {
      const iid = String(c.instructor);
      if (!byInstructor[iid]) byInstructor[iid] = [];
      byInstructor[iid].push(c);
    }

    res.json(instructors.map((i) => {
      const myCourses = byInstructor[String(i._id)] || [];
      return {
        ...i.toObject(),
        status: i.status || "active",
        courses: myCourses.map((c) => ({ _id: c._id, title: c.title, status: c.status, studentsEnrolled: c.studentsEnrolled || 0 })),
        totalCourses: myCourses.length,
        totalStudents: myCourses.reduce((a, c) => a + (c.studentsEnrolled || 0), 0),
        totalRevenue: myCourses.reduce((a, c) => a + (c.revenue || 0), 0),
      };
    }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/courses", protect, adminOnly, async (req, res) => {
  try {
    const courses = await Course.find({}).populate("instructor", "name email").sort("-createdAt");
    res.json(courses);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.patch("/api/admin/courses/:id/status", protect, adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["published", "draft", "review"].includes(status)) return res.status(400).json({ message: "Invalid status." });
    const course = await Course.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!course) return res.status(404).json({ message: "Course not found." });
    res.json(course);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/enrollments", protect, adminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const query = status && status !== "all" ? { paymentStatus: status } : {};
    const enrollments = await Enrollment.find(query)
      .sort("-createdAt")
      .populate("student", "name email")
      .populate("course", "title thumbnail price");
    res.json(enrollments.map((e) => ({
      _id: e._id,
      status: e.paymentStatus,
      student: e.student,
      course: e.course,
      whatsapp: e.whatsapp,
      paymentMethod: e.paymentMethod,
      paymentScreenshotUrl: e.paymentScreenshotUrl,
      amount: e.amount,
      currency: e.currency,
      rejectionReason: e.rejectionReason,
      createdAt: e.createdAt,
      verifiedAt: e.verifiedAt,
    })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.patch("/api/admin/enrollments/:id/verify", protect, adminOnly, async (req, res) => {
  try {
    const enrollment = await Enrollment.findById(req.params.id);
    if (!enrollment) return res.status(404).json({ message: "Enrollment not found." });

    const alreadyVerified = enrollment.paymentStatus === "verified";
    enrollment.paymentStatus = "verified";
    enrollment.verifiedBy = req.user._id;
    enrollment.verifiedAt = new Date();
    await enrollment.save();

    // Grant course access now — this is the step that used to run
    // immediately on submission (see the note above in
    // POST /api/enrollments/:courseId).
    if (!alreadyVerified) {
      const course = await Course.findById(enrollment.course);
      if (course) {
        course.studentsEnrolled = (course.studentsEnrolled || 0) + 1;
        course.students         = (course.students || 0) + 1;
        course.revenue          = (course.revenue || 0) + (course.price || 0);
        await course.save();
      }
      await Progress.findOneAndUpdate(
        { student: enrollment.student, courseId: enrollment.course },
        { $setOnInsert: { student: enrollment.student, courseId: enrollment.course, completedLectures: [] } },
        { upsert: true, new: true }
      );
    }

    const populated = await Enrollment.findById(enrollment._id)
      .populate("student", "name email")
      .populate("course", "title thumbnail price");
    res.json({
      _id: populated._id,
      status: populated.paymentStatus,
      student: populated.student,
      course: populated.course,
      whatsapp: populated.whatsapp,
      paymentMethod: populated.paymentMethod,
      paymentScreenshotUrl: populated.paymentScreenshotUrl,
      amount: populated.amount,
      rejectionReason: populated.rejectionReason,
      createdAt: populated.createdAt,
      verifiedAt: populated.verifiedAt,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.patch("/api/admin/enrollments/:id/reject", protect, adminOnly, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ message: "A rejection reason is required." });

    const enrollment = await Enrollment.findByIdAndUpdate(
      req.params.id,
      { paymentStatus: "rejected", rejectionReason: reason.trim(), verifiedBy: req.user._id, verifiedAt: new Date() },
      { new: true }
    ).populate("student", "name email").populate("course", "title thumbnail price");

    if (!enrollment) return res.status(404).json({ message: "Enrollment not found." });
    res.json({
      _id: enrollment._id,
      status: enrollment.paymentStatus,
      student: enrollment.student,
      course: enrollment.course,
      whatsapp: enrollment.whatsapp,
      paymentMethod: enrollment.paymentMethod,
      paymentScreenshotUrl: enrollment.paymentScreenshotUrl,
      amount: enrollment.amount,
      rejectionReason: enrollment.rejectionReason,
      createdAt: enrollment.createdAt,
      verifiedAt: enrollment.verifiedAt,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.patch("/api/admin/users/:id/status", protect, adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "suspended"].includes(status)) return res.status(400).json({ message: "Invalid status." });

    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ message: "User not found." });
    if (target.role === "admin") return res.status(400).json({ message: "Cannot change status of a super admin account." });

    target.status = status;
    await target.save();
    res.json({ _id: target._id, status: target.status });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// PROGRESS ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/progress/mark", protect, async (req, res) => {
  try {
    const { courseId, lectureId } = req.body;
    if (!courseId || !lectureId) return res.status(400).json({ message: "courseId and lectureId are required" });
    if (!(await Enrollment.findOne({ student: req.user._id, course: courseId })))
      return res.status(403).json({ message: "Not enrolled in this course" });

    let progress = await Progress.findOne({ student: req.user._id, courseId });
    if (!progress) progress = new Progress({ student: req.user._id, courseId, completedLectures: [] });
    const lid = String(lectureId);
    if (!progress.completedLectures.includes(lid)) progress.completedLectures.push(lid);
    await progress.save();
    res.json(progress);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/progress/my", protect, async (req, res) => {
  try {
    res.json(await Progress.find({ student: req.user._id }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// NOTES — Student Portal, per-lecture timestamped notes
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/notes/:courseId", protect, async (req, res) => {
  try {
    const notes = await Note.find({ student: req.user._id, courseId: req.params.courseId }).sort("-createdAt");
    res.json(notes);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/notes", protect, async (req, res) => {
  try {
    const { courseId, lectureId, lectureTitle, content } = req.body || {};
    if (!courseId || !lectureId || !content || !content.trim())
      return res.status(400).json({ message: "courseId, lectureId, and content are required" });
    if (!(await Enrollment.findOne({ student: req.user._id, course: courseId, paymentStatus: "verified" })))
      return res.status(403).json({ message: "Not enrolled in this course" });
    const note = await Note.create({
      student: req.user._id, courseId, lectureId: String(lectureId),
      lectureTitle: lectureTitle || "", content: content.trim(),
    });
    res.status(201).json(note);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete("/api/notes/:id", protect, async (req, res) => {
  try {
    const note = await Note.findOneAndDelete({ _id: req.params.id, student: req.user._id });
    if (!note) return res.status(404).json({ message: "Note not found" });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Q&A — Student Portal, per-course questions with embedded answers
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/courses/:courseId/questions", protect, async (req, res) => {
  try {
    const questions = await Question.find({ courseId: req.params.courseId })
      .populate("author", "name avatar")
      .populate("answers.author", "name avatar")
      .sort("-createdAt");
    res.json(questions);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/courses/:courseId/questions", protect, async (req, res) => {
  try {
    const { lectureId, lectureTitle, text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ message: "Question text is required" });
    if (!(await Enrollment.findOne({ student: req.user._id, course: req.params.courseId, paymentStatus: "verified" })))
      return res.status(403).json({ message: "Not enrolled in this course" });
    const question = await Question.create({
      author: req.user._id, courseId: req.params.courseId,
      lectureId: lectureId ? String(lectureId) : "", lectureTitle: lectureTitle || "",
      text: text.trim(),
    });
    const populated = await Question.findById(question._id).populate("author", "name avatar");
    res.status(201).json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/questions/:id/answers", protect, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ message: "Answer text is required" });
    const question = await Question.findById(req.params.id);
    if (!question) return res.status(404).json({ message: "Question not found" });
    question.answers.push({ author: req.user._id, text: text.trim() });
    await question.save();
    const populated = await Question.findById(question._id)
      .populate("author", "name avatar")
      .populate("answers.author", "name avatar");
    res.json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/questions/:id/upvote", protect, async (req, res) => {
  try {
    const question = await Question.findById(req.params.id);
    if (!question) return res.status(404).json({ message: "Question not found" });
    const uid = String(req.user._id);
    const already = question.upvotes.some((u) => String(u) === uid);
    if (already) question.upvotes = question.upvotes.filter((u) => String(u) !== uid);
    else question.upvotes.push(req.user._id);
    await question.save();
    res.json({ upvotes: question.upvotes.length, upvoted: !already });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// REVIEW ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/courses/:courseId/reviews", async (req, res) => {
  try {
    const reviews = await Review.find({ course: req.params.courseId })
      .populate("student", "name avatar")
      .sort("-createdAt")
      .limit(100);
    res.json(reviews.map(r => ({
      _id:        r._id,
      rating:     r.rating,
      comment:    r.comment || r.text,
      text:       r.comment || r.text,
      createdAt:  r.createdAt,
      user:       r.student,
      author:     r.authorName || r.student?.name || "Anonymous",
      authorName: r.authorName || r.student?.name || "",
    })));
  } catch (err) { res.status(500).json({ message: "Could not fetch reviews" }); }
});

app.post("/api/courses/:courseId/reviews", optionalProtect, async (req, res) => {
  try {
    const { rating, comment, text, authorName, name } = req.body;
    const reviewText = (text || comment || "").trim();
    const reviewerName = (authorName || name || req.user?.name || "").trim();

    if (!rating) return res.status(400).json({ message: "Rating is required" });
    if (!reviewerName) return res.status(400).json({ message: "Reviewer name is required" });
    if (!reviewText) return res.status(400).json({ message: "Review text is required" });

    const review = await Review.create({
      course:     req.params.courseId,
      student:    req.user?._id || undefined,
      authorName: reviewerName,
      rating:     Number(rating),
      comment:    reviewText,
      text:       reviewText,
    });

    const all = await Review.find({ course: req.params.courseId });
    const avg = all.reduce((a, r) => a + r.rating, 0) / all.length;
    await Course.findByIdAndUpdate(req.params.courseId, {
      rating:       Math.round(avg * 10) / 10,
      totalRatings: all.length,
      reviews:      all.length,
    });

    const populated = await Review.findById(review._id).populate("student", "name avatar");
    const displayName = populated.authorName || populated.student?.name || reviewerName;
    res.status(201).json({
      _id:        populated._id,
      rating:     populated.rating,
      comment:    populated.comment,
      text:       populated.text,
      createdAt:  populated.createdAt,
      author:     displayName,
      authorName: displayName,
      user:       populated.student,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// UPLOAD ROUTES — CLOUDINARY (stream, no disk)
// ══════════════════════════════════════════════════════════════════════════════

// ── Multer instances (memory storage) ────────────────────────────────────────
const imageMulter = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },          // 10 MB
  fileFilter: (_, file, cb) => {
    const ok = ["image/jpeg","image/jpg","image/png","image/webp","image/gif"];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only image files are allowed (JPG, PNG, WebP, GIF)"));
  },
});

const videoMulter = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 500 * 1024 * 1024 },          // 500 MB
  fileFilter: (_, file, cb) => {
    const ok = ["video/mp4","video/webm","video/ogg","video/quicktime","video/x-msvideo"];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only video files are allowed (MP4, WebM, MOV, AVI)"));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload/image
// Used by: course thumbnail, image testimonials, project gallery, profile avatar
// Access:  any authenticated user (instructors AND students — avatars need it)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/upload/image", protect, requireCloudinary, imageMulter.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const isAvatar = req.body.type === "avatar" || req.body.uploadType === "avatar";

    // Choose Cloudinary folder based on upload type
    const folder = isAvatar
      ? "learnify/instructor-avatars"
      : req.user.role === "instructor"
        ? "learnify/course-images"
        : "learnify/avatars";

    const result = await streamToCloudinary(req.file.buffer, {
      folder,
      resource_type:   "image",
      allowed_formats: ["jpg","jpeg","png","webp","gif"],
      transformation:  isAvatar
        ? [
            { width: 400, height: 400, crop: "fill", gravity: "auto" },
            { quality: "auto:good" },
            { fetch_format: "auto" },
          ]
        : [
            { width: 1280, height: 720, crop: "limit" },
            { quality: "auto:good" },
            { fetch_format: "auto" },
          ],
    });

    // If a courseId was supplied with the thumbnail upload, persist it immediately
    if (req.body.courseId && mongoose.Types.ObjectId.isValid(req.body.courseId)) {
      await Course.findOneAndUpdate(
        { _id: req.body.courseId, instructor: req.user._id },
        { thumbnail: result.secure_url }
      );
    }

    console.log("✅ Image uploaded:", result.secure_url);
    res.json({
      url:        result.secure_url,
      secure_url: result.secure_url,
      imageUrl:   result.secure_url,
      publicId:   result.public_id,
      width:      result.width,
      height:     result.height,
      format:     result.format,
    });
  } catch (err) {
    console.error("❌ Image upload error:", err.message);
    res.status(500).json({ message: "Failed to upload image", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload/payment-screenshot
// Used by: EnrolledPage.jsx (Step 2) — the visitor attaches a screenshot of
// their bank/JazzCash/Easypaisa/etc. payment before enrollment is confirmed.
// Access:  PUBLIC — deliberately no `protect` here. A guest submits this
// screenshot BEFORE they have an account (account creation happens right
// after, via /auth/register), so there is no auth token to check yet.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/upload/payment-screenshot", requireCloudinary, imageMulter.single("screenshot"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No screenshot uploaded" });

    // ── Fraud check: has this exact screenshot been submitted before? ──────
    // Hash the raw file bytes and look it up before uploading anywhere. This
    // catches the same image being reused for a second enrollment, whether
    // it's the same person trying again or someone else forwarding it.
    const screenshotHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const alreadyUsed = await PaymentScreenshotHash.findOne({ hash: screenshotHash });
    if (alreadyUsed) {
      return res.status(409).json({
        message: "This payment screenshot has already been submitted. Please attach a screenshot of a different, unused payment.",
      });
    }

    const result = await streamToCloudinary(req.file.buffer, {
      folder:           "learnify/payment-screenshots",
      resource_type:    "image",
      allowed_formats:  ["jpg", "jpeg", "png", "webp"],
      transformation:   [
        { width: 1600, height: 1600, crop: "limit" },
        { quality: "auto:good" },
        { fetch_format: "auto" },
      ],
      // Tag with the course so screenshots are easy to find/audit per course
      context: req.body.courseId ? { courseId: String(req.body.courseId) } : undefined,
    });

    // Record the hash now that the screenshot has been accepted, so the
    // very next duplicate submission (of this same file) gets caught above.
    try {
      await PaymentScreenshotHash.create({
        hash:     screenshotHash,
        courseId: req.body.courseId ? String(req.body.courseId) : "",
        url:      result.secure_url,
      });
    } catch (hashSaveErr) {
      // A duplicate-key error here means two identical uploads raced each
      // other — extremely unlikely, but if it happens the upload itself
      // still succeeded, so we just log it rather than fail the request.
      console.warn("⚠️  Could not record screenshot hash:", hashSaveErr.message);
    }

    console.log("✅ Payment screenshot uploaded:", result.secure_url);
    res.json({
      url:        result.secure_url,
      secure_url: result.secure_url,
      publicId:   result.public_id,
      width:      result.width,
      height:     result.height,
      format:     result.format,
    });
  } catch (err) {
    console.error("❌ Payment screenshot upload error:", err.message);
    res.status(500).json({ message: "Failed to upload payment screenshot", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload/video
// Used by: video testimonials upload in InstructorDashboard
// Access:  instructors only
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/upload/video", protect, instructorOnly, requireCloudinary, videoMulter.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No video file uploaded" });

    const result = await streamToCloudinary(req.file.buffer, {
      folder:        "learnify/video-testimonials",
      resource_type: "video",
      // async transcoding — response is instant, Cloudinary processes in background
      eager: [
        { streaming_profile: "hd", format: "m3u8" },              // HLS
        { width: 1280, height: 720, crop: "limit", format: "mp4" }, // 720p MP4
      ],
      eager_async: true,
    });

    console.log("✅ Video uploaded:", result.secure_url);
    res.json({
      url:        result.secure_url,
      secure_url: result.secure_url,
      videoUrl:   result.secure_url,
      publicId:   result.public_id,
      duration:   result.duration,  // seconds (Cloudinary auto-detects)
      format:     result.format,
      bytes:      result.bytes,
    });
  } catch (err) {
    console.error("❌ Video upload error:", err.message);
    res.status(500).json({ message: "Failed to upload video", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/upload/image/:publicId  &  DELETE /api/upload/video/:publicId
// ─────────────────────────────────────────────────────────────────────────────
app.delete("/api/upload/image/:publicId", protect, instructorOnly, async (req, res) => {
  try {
    const result = await cloudinary.uploader.destroy(decodeURIComponent(req.params.publicId), { resource_type: "image" });
    result.result === "ok"
      ? res.json({ message: "Image deleted", publicId: req.params.publicId })
      : res.status(404).json({ message: "Image not found or already deleted" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete("/api/upload/video/:publicId", protect, instructorOnly, async (req, res) => {
  try {
    const result = await cloudinary.uploader.destroy(decodeURIComponent(req.params.publicId), { resource_type: "video" });
    result.result === "ok"
      ? res.json({ message: "Video deleted", publicId: req.params.publicId })
      : res.status(404).json({ message: "Video not found or already deleted" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SITE THEME — Schema, Middleware, Routes
// ══════════════════════════════════════════════════════════════════════════════

const SiteThemeSchema = new mongoose.Schema({
  status: { type: String, enum: ["draft", "published"], default: "draft" },
  version: { type: Number, default: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  publishedAt: Date,
  settings: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });
const SiteTheme = mongoose.model("SiteTheme", SiteThemeSchema);

const SiteThemeHistorySchema = new mongoose.Schema({
  themeId: { type: mongoose.Schema.Types.ObjectId, ref: "SiteTheme", required: true },
  version: { type: Number, required: true },
  settings: { type: mongoose.Schema.Types.Mixed, required: true },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["draft", "published"], required: true },
}, { timestamps: true });
const SiteThemeHistory = mongoose.model("SiteThemeHistory", SiteThemeHistorySchema);

const ThemePresetSchema = new mongoose.Schema({
  name: { type: String, required: true },
  settings: { type: mongoose.Schema.Types.Mixed, required: true },
  isDefault: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
const ThemePreset = mongoose.model("ThemePreset", ThemePresetSchema);

const themeEditorOnly = (req, res, next) => {
  // Super Admin always has access, regardless of the env-var email below —
  // this is what SuperAdminDashboard.jsx's Theme Editor tab relies on.
  if (req.user?.role === "admin") return next();
  const adminEmail = (process.env.THEME_EDITOR_ADMIN_EMAIL || "").toLowerCase().trim();
  if (adminEmail && req.user && req.user.email.toLowerCase().trim() === adminEmail) return next();
  return res.status(403).json({ message: "Access denied — theme editor permission required" });
};

// Check if current user has theme editor access
app.get("/api/theme/access", protect, (req, res) => {
  const adminEmail = (process.env.THEME_EDITOR_ADMIN_EMAIL || "").toLowerCase().trim();
  const hasAccess = req.user.role === "admin" || (Boolean(adminEmail) && req.user.email.toLowerCase().trim() === adminEmail);
  res.json({ hasAccess });
});

// Get published theme (public — used by the course page)
app.get("/api/theme/published", async (req, res) => {
  try {
    const theme = await SiteTheme.findOne({ status: "published" }).sort("-publishedAt");
    res.json(theme ? theme.settings : null);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Get draft theme
app.get("/api/theme/draft", protect, themeEditorOnly, async (req, res) => {
  try {
    let draft = await SiteTheme.findOne({ status: "draft", createdBy: req.user._id }).sort("-updatedAt");
    if (!draft) {
      const published = await SiteTheme.findOne({ status: "published" }).sort("-publishedAt");
      draft = await SiteTheme.create({
        status: "draft",
        createdBy: req.user._id,
        settings: published ? published.settings : {},
        version: published ? published.version + 1 : 1,
      });
    }
    res.json(draft);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Save draft
app.put("/api/theme/draft", protect, themeEditorOnly, async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings) return res.status(400).json({ message: "Settings are required" });
    let draft = await SiteTheme.findOne({ status: "draft", createdBy: req.user._id }).sort("-updatedAt");
    if (draft) {
      draft.settings = settings;
      draft.version = (draft.version || 0) + 1;
      await draft.save();
    } else {
      draft = await SiteTheme.create({ status: "draft", createdBy: req.user._id, settings, version: 1 });
    }
    res.json(draft);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Publish theme
app.post("/api/theme/publish", protect, themeEditorOnly, async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings) return res.status(400).json({ message: "Settings are required" });
    // Archive previous published
    await SiteTheme.updateMany({ status: "published" }, { status: "draft" });
    // Create published version
    const nextVersion = (await SiteTheme.countDocuments()) + 1;
    const theme = await SiteTheme.create({
      status: "published",
      createdBy: req.user._id,
      settings,
      version: nextVersion,
      publishedAt: new Date(),
    });
    // Save to history
    await SiteThemeHistory.create({
      themeId: theme._id,
      version: nextVersion,
      settings,
      changedBy: req.user._id,
      status: "published",
    });
    // Clean up user's drafts
    await SiteTheme.deleteMany({ status: "draft", createdBy: req.user._id });
    res.json(theme);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Reset theme (delete all drafts for this user)
app.post("/api/theme/reset", protect, themeEditorOnly, async (req, res) => {
  try {
    await SiteTheme.deleteMany({ status: "draft", createdBy: req.user._id });
    res.json({ message: "Draft reset successfully" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Theme history
app.get("/api/theme/history", protect, themeEditorOnly, async (req, res) => {
  try {
    const history = await SiteThemeHistory.find()
      .populate("changedBy", "name email")
      .sort("-createdAt")
      .limit(50);
    res.json(history);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Restore from history
app.post("/api/theme/restore/:historyId", protect, themeEditorOnly, async (req, res) => {
  try {
    const entry = await SiteThemeHistory.findById(req.params.historyId);
    if (!entry) return res.status(404).json({ message: "History entry not found" });
    let draft = await SiteTheme.findOne({ status: "draft", createdBy: req.user._id }).sort("-updatedAt");
    if (draft) {
      draft.settings = entry.settings;
      draft.version = (draft.version || 0) + 1;
      await draft.save();
    } else {
      draft = await SiteTheme.create({ status: "draft", createdBy: req.user._id, settings: entry.settings, version: entry.version });
    }
    res.json(draft);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Theme presets
app.get("/api/theme/presets", protect, themeEditorOnly, async (req, res) => {
  try { res.json(await ThemePreset.find().sort("-updatedAt")); }
  catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/theme/presets", protect, themeEditorOnly, async (req, res) => {
  try {
    const { name, settings } = req.body;
    if (!name || !settings) return res.status(400).json({ message: "Name and settings are required" });
    const preset = await ThemePreset.create({ name, settings, createdBy: req.user._id });
    res.status(201).json(preset);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put("/api/theme/presets/:id", protect, themeEditorOnly, async (req, res) => {
  try {
    const preset = await ThemePreset.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!preset) return res.status(404).json({ message: "Preset not found" });
    res.json(preset);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete("/api/theme/presets/:id", protect, themeEditorOnly, async (req, res) => {
  try {
    await ThemePreset.findByIdAndDelete(req.params.id);
    res.json({ message: "Preset deleted" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Export theme
app.get("/api/theme/export", protect, themeEditorOnly, async (req, res) => {
  try {
    const theme = await SiteTheme.findOne({ status: "published" }).sort("-publishedAt");
    res.json({ settings: theme ? theme.settings : {}, exportedAt: new Date().toISOString(), version: theme?.version || 0 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Import theme
app.post("/api/theme/import", protect, themeEditorOnly, async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== "object") return res.status(400).json({ message: "Invalid theme data" });
    let draft = await SiteTheme.findOne({ status: "draft", createdBy: req.user._id }).sort("-updatedAt");
    if (draft) {
      draft.settings = settings;
      draft.version = (draft.version || 0) + 1;
      await draft.save();
    } else {
      draft = await SiteTheme.create({ status: "draft", createdBy: req.user._id, settings, version: 1 });
    }
    res.json(draft);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SITE SETTINGS (LOGO) · CONTACT US · NEWSLETTER
// ══════════════════════════════════════════════════════════════════════════════

// Public — read the current site settings (logo etc). Used by the footer and
// anywhere else the logo needs to render.
app.get("/api/settings", async (req, res) => {
  try {
    const settings = await getSiteSettings();
    res.json({
      logoUrl:       settings.logoUrl       || "",
      footerLogoUrl: settings.footerLogoUrl || "",
      paymentLogoUbl:       settings.paymentLogoUbl       || "",
      paymentLogoAllied:    settings.paymentLogoAllied    || "",
      paymentLogoJazzcash:  settings.paymentLogoJazzcash  || "",
      paymentLogoEasypaisa: settings.paymentLogoEasypaisa || "",
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Super Admin — upload/replace a site logo. Goes to the same Cloudinary
// account as every other image upload in this file.
// The form sends a "target" field alongside the image: "header", "footer",
// or one of the four payment-method logos ("payment_ubl", "payment_allied",
// "payment_jazzcash", "payment_easypaisa"). Anything unrecognized falls back
// to "header" so existing callers keep working unchanged.
const LOGO_TARGET_FIELDS = {
  header:            "logoUrl",
  footer:             "footerLogoUrl",
  payment_ubl:        "paymentLogoUbl",
  payment_allied:     "paymentLogoAllied",
  payment_jazzcash:   "paymentLogoJazzcash",
  payment_easypaisa:  "paymentLogoEasypaisa",
};
app.post("/api/admin/settings/logo", protect, adminOnly, requireCloudinary, imageMulter.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const targetField = LOGO_TARGET_FIELDS[req.body?.target] || "logoUrl";
    const result = await streamToCloudinary(req.file.buffer, {
      folder: "learnify/site-settings",
      resource_type: "image",
      allowed_formats: ["jpg", "jpeg", "png", "webp", "svg"],
      transformation: [{ width: 600, height: 600, crop: "limit" }, { quality: "auto:good" }, { fetch_format: "auto" }],
    });
    const settings = await getSiteSettings();
    settings[targetField] = result.secure_url;
    await settings.save();
    res.json({
      logoUrl:       settings.logoUrl       || "",
      footerLogoUrl: settings.footerLogoUrl || "",
      paymentLogoUbl:       settings.paymentLogoUbl       || "",
      paymentLogoAllied:    settings.paymentLogoAllied    || "",
      paymentLogoJazzcash:  settings.paymentLogoJazzcash  || "",
      paymentLogoEasypaisa: settings.paymentLogoEasypaisa || "",
    });
  } catch (err) {
    console.error("❌ Logo upload error:", err.message);
    res.status(500).json({ message: "Failed to upload logo", error: err.message });
  }
});

// Public — Contact Us page submission.
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name?.trim() || !email?.trim() || !message?.trim())
      return res.status(400).json({ message: "Name, email and message are required." });
    const submission = await ContactSubmission.create({
      name: name.trim(), email: email.trim().toLowerCase(), message: message.trim(),
    });
    res.status(201).json(submission);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Super Admin — list Contact Us submissions.
app.get("/api/admin/contact-submissions", protect, adminOnly, async (req, res) => {
  try {
    res.json(await ContactSubmission.find({}).sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Super Admin — mark a submission read.
app.patch("/api/admin/contact-submissions/:id/read", protect, adminOnly, async (req, res) => {
  try {
    const sub = await ContactSubmission.findByIdAndUpdate(req.params.id, { status: "read" }, { new: true });
    if (!sub) return res.status(404).json({ message: "Submission not found." });
    res.json(sub);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Public — footer newsletter signup. Upsert so re-submitting the same email
// doesn't throw a duplicate-key error, it just no-ops.
app.post("/api/newsletter", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email?.trim()) return res.status(400).json({ message: "Email is required." });
    const clean = email.trim().toLowerCase();
    const sub = await NewsletterSubscriber.findOneAndUpdate(
      { email: clean },
      { email: clean },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json(sub);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Super Admin — list newsletter subscribers.
app.get("/api/admin/newsletter-subscribers", protect, adminOnly, async (req, res) => {
  try {
    res.json(await NewsletterSubscriber.find({}).sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// MULTER ERROR HANDLER — must be after all routes
// Catches file-size and MIME-type rejections; returns clean JSON
// ══════════════════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(413).json({ message: "File too large. Max: 10 MB for images, 500 MB for videos." });
    return res.status(400).json({ message: `Upload error: ${err.message}` });
  }
  if (err?.message?.match(/^Only (image|video) files/))
    return res.status(415).json({ message: err.message });
  next(err);
});

// ══════════════════════════════════════════════════════════════════════════════
// 404 + GLOBAL ERROR HANDLER
// ══════════════════════════════════════════════════════════════════════════════
app.use((req, res) => res.status(404).json({ message: `Route ${req.method} ${req.path} not found` }));

app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err.message);
  res.status(500).json({ success: false, message: err.message || "Internal Server Error" });
});

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀  Server  →  http://localhost:${PORT}`);
  console.log(`🌍  CORS    →  ${allowedOrigins.join(", ")}`);
  console.log(`☁️   Cloud  →  ${process.env.CLOUDINARY_CLOUD_NAME ?? "⚠️  NOT SET"}`);
});
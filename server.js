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
  avatar:   String,
  bio:      String,
  title:    String,
  location: String,
  website:  String,
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

// ── Review ────────────────────────────────────────────────────────────────────
const ReviewSchema = new mongoose.Schema({
  course:  { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User",   required: true },
  rating:  { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: "" },
  text:    { type: String, default: "" },
}, { timestamps: true });
ReviewSchema.index({ course: 1, student: 1 }, { unique: true });
const Review = mongoose.model("Review", ReviewSchema);

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
    next();
  } catch {
    res.status(401).json({ message: "Token is invalid or expired" });
  }
};

const instructorOnly = (req, res, next) => {
  if (req.user?.role !== "instructor")
    return res.status(403).json({ message: "Access denied — instructors only" });
  next();
};

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
      user:  { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar },
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
    res.json({
      token: signToken(user._id),
      user:  { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, bio: user.bio, title: user.title, createdAt: user.createdAt },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ message: "Login failed." });
  }
});

app.get("/api/auth/me", protect, (req, res) => {
  const u = req.user;
  res.json({ _id: u._id, name: u.name, email: u.email, role: u.role, avatar: u.avatar, bio: u.bio, title: u.title, location: u.location, website: u.website, createdAt: u.createdAt });
});

app.patch("/api/auth/profile", protect, async (req, res) => {
  try {
    const { name, bio, title, location, website, avatar } = req.body;
    const user = await User.findByIdAndUpdate(req.user._id, { name, bio, title, location, website, avatar }, { new: true, runValidators: true }).select("-password");
    res.json(user);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// USER ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
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
      .populate("instructor", "name avatar title bio location website");
    if (!course) return res.status(404).json({ message: "Course not found" });

    // Fetch & format reviews
    const dbReviews = await Review.find({ course: req.params.id })
      .populate("student", "name avatar")
      .sort("-createdAt")
      .limit(50);

    const reviews_list = dbReviews.map(r => ({
      _id:     r._id,
      author:  r.student?.name || "Anonymous",
      avatar:  r.student?.avatar || "",
      rating:  r.rating,
      text:    r.comment || r.text || "",
      date:    r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "Recently",
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
    res.json({ enrolled: Boolean(enrollment), isEnrolled: Boolean(enrollment) });
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

    const enrollment = await Enrollment.create({ student: req.user._id, course: req.params.courseId });
    await Course.findByIdAndUpdate(req.params.courseId, { $inc: { studentsEnrolled: 1, students: 1 } });
    await Progress.findOneAndUpdate(
      { student: req.user._id, courseId: req.params.courseId },
      { $setOnInsert: { student: req.user._id, courseId: req.params.courseId, completedLectures: [] } },
      { upsert: true, new: true }
    );
    res.status(201).json(enrollment);
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
// REVIEW ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/courses/:courseId/reviews", async (req, res) => {
  try {
    const reviews = await Review.find({ course: req.params.courseId })
      .populate("student", "name avatar")
      .sort("-createdAt")
      .limit(100);
    res.json(reviews.map(r => ({
      _id:       r._id,
      rating:    r.rating,
      comment:   r.comment || r.text,
      text:      r.comment || r.text,
      createdAt: r.createdAt,
      user:      r.student,
      author:    r.student?.name || "Anonymous",
    })));
  } catch (err) { res.status(500).json({ message: "Could not fetch reviews" }); }
});

app.post("/api/courses/:courseId/reviews", protect, async (req, res) => {
  try {
    const { rating, comment, text } = req.body;
    const reviewText = text || comment || "";
    if (!rating) return res.status(400).json({ message: "Rating is required" });

    if (await Review.findOne({ course: req.params.courseId, student: req.user._id }))
      return res.status(400).json({ message: "You have already reviewed this course" });

    const review = await Review.create({
      course:  req.params.courseId,
      student: req.user._id,
      rating:  Number(rating),
      comment: reviewText,
      text:    reviewText,
    });

    const all = await Review.find({ course: req.params.courseId });
    const avg = all.reduce((a, r) => a + r.rating, 0) / all.length;
    await Course.findByIdAndUpdate(req.params.courseId, {
      rating:       Math.round(avg * 10) / 10,
      totalRatings: all.length,
      reviews:      all.length,
    });

    const populated = await Review.findById(review._id).populate("student", "name avatar");
    res.status(201).json({
      _id:       populated._id,
      rating:    populated.rating,
      comment:   populated.comment,
      text:      populated.text,
      createdAt: populated.createdAt,
      user:      populated.student,
    });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "Already reviewed" });
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

    // Choose Cloudinary folder based on caller role
    const folder = req.user.role === "instructor"
      ? "learnify/course-images"
      : "learnify/avatars";

    const result = await streamToCloudinary(req.file.buffer, {
      folder,
      resource_type:   "image",
      allowed_formats: ["jpg","jpeg","png","webp","gif"],
      transformation:  [
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
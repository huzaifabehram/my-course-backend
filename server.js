// Server/server.js — Complete MERN Backend
const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");
const multer   = require("multer");
const path     = require("path");
const fs       = require("fs");
require("dotenv").config();
const { cloudinary } = require("./config/cloudinary");

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:3000",
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json());
app.use("/uploads", express.static("uploads"));

// ─── DB CONNECTION ─────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true,
})
  .then(() => console.log("✅ MongoDB connected to learnify database"))
  .catch(err => console.error("❌ MongoDB connection error:", err.message));

mongoose.connection.on("disconnected", () => console.log("⚠️  MongoDB disconnected"));
mongoose.connection.on("reconnected",  () => console.log("✅ MongoDB reconnected"));

// ─── DEPENDENCIES ─────────────────────────────────────────────────────────────
const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");

// ─── MODELS ───────────────────────────────────────────────────────────────────

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
  if (this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});
UserSchema.methods.matchPassword = function(plainPassword) {
  return bcrypt.compare(plainPassword, this.password);
};
const User = mongoose.model("User", UserSchema);

// ── Lecture & Section (Mixed _id to accept frontend temp IDs) ─────────────────
const LectureSchema = new mongoose.Schema({
  _id:       { type: mongoose.Schema.Types.Mixed },
  title:     { type: String, default: "Untitled Lecture" },
  type:      { type: String, default: "video" },
  duration:  { type: String, default: "" },
  free:      { type: Boolean, default: false },
  videoUrl:  { type: String, default: "" },
  preview:   { type: Boolean, default: false },
  resources: [String],
}, { _id: false });

const SectionSchema = new mongoose.Schema({
  _id:      { type: mongoose.Schema.Types.Mixed },
  title:    { type: String, default: "Untitled Section" },
  lectures: { type: [LectureSchema], default: [] },
}, { _id: false });

// ── Testimonial Schemas ───────────────────────────────────────────────────────
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
  imageTestimonials: { type: [ImageTestimonialSchema], default: [] },
  videoTestimonials: { type: [VideoTestimonialSchema], default: [] },
  projectGallery:    { type: [ProjectGallerySchema], default: [] },
  alsoBoughtCourseIds: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Course" }],
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

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
const protect = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Not authorized — no token provided" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");
    if (!req.user) return res.status(401).json({ message: "User not found" });
    next();
  } catch (err) {
    res.status(401).json({ message: "Token is invalid or expired" });
  }
};

const instructorOnly = (req, res, next) => {
  if (req.user?.role !== "instructor") {
    return res.status(403).json({ message: "Access denied — instructors only" });
  }
  next();
};

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });

// ─── Health check / root route ────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:    "ok",
    message:   "Learnify API is running 🚀",
    version:   "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// ─── SANITIZE SECTIONS & TESTIMONIALS ────────────────────────────────────────
function sanitizeSections(body) {
  const data = { ...body };
  if (!Array.isArray(data.sections)) return data;

  data.sections = data.sections.map((section) => {
    const sec = { ...section };
    if (!sec._id) sec._id = sec.id || new mongoose.Types.ObjectId().toString();
    delete sec.id;

    if (Array.isArray(sec.lectures)) {
      sec.lectures = sec.lectures.map((lec) => {
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

function sanitizeTestimonials(items) {
  if (!Array.isArray(items)) return [];
  return items.map(({ id, ...rest }) => rest);
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

// Register
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }
    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(400).json({ message: "Email is already registered" });

    const user = await User.create({
      name:     name.trim(),
      email:    email.toLowerCase().trim(),
      password,
      role:     role === "instructor" ? "instructor" : "student",
    });

    res.status(201).json({
      token: signToken(user._id),
      user:  { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar },
    });
  } catch (err) {
    console.error("Register error:", err.message);
    res.status(500).json({ message: "Registration failed. Please try again." });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    res.json({
      token: signToken(user._id),
      user: {
        _id:       user._id,
        name:      user.name,
        email:     user.email,
        role:      user.role,
        avatar:    user.avatar,
        bio:       user.bio,
        title:     user.title,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ message: "Login failed. Please try again." });
  }
});

// Get current user
app.get("/api/auth/me", protect, (req, res) => {
  const u = req.user;
  res.json({
    _id:       u._id,
    name:      u.name,
    email:     u.email,
    role:      u.role,
    avatar:    u.avatar,
    bio:       u.bio,
    title:     u.title,
    location:  u.location,
    website:   u.website,
    createdAt: u.createdAt,
  });
});

// Update profile
app.patch("/api/auth/profile", protect, async (req, res) => {
  try {
    const { name, bio, title, location, website, avatar } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { name, bio, title, location, website, avatar },
      { new: true, runValidators: true }
    ).select("-password");
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── USER ROUTES ──────────────────────────────────────────────────────────────

// Get user by ID (for instructor info)
app.get("/api/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── COURSE ROUTES ────────────────────────────────────────────────────────────

// Instructor: get my courses
app.get("/api/courses/instructor/my-courses", protect, instructorOnly, async (req, res) => {
  try {
    const courses = await Course.find({ instructor: req.user._id }).sort("-createdAt");
    res.json(courses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Alias for backward compatibility
app.get("/api/courses/instructor/mine", protect, instructorOnly, async (req, res) => {
  try {
    const courses = await Course.find({ instructor: req.user._id }).sort("-createdAt");
    res.json(courses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: list all published courses
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
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: single course detail (with full sections, testimonials, and reviews)
app.get("/api/courses/:id", async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate("instructor", "name avatar title bio location website");
    
    if (!course) return res.status(404).json({ message: "Course not found" });

    // Fetch reviews for this course
    const reviews = await Review.find({ course: req.params.id })
      .populate("student", "name avatar")
      .sort({ createdAt: -1 })
      .limit(50);

    // Map reviews to the format expected by frontend
    const reviews_list = reviews.map((r) => ({
      _id: r._id,
      id: r._id,
      author: r.student?.name || "Anonymous",
      avatar: r.student?.avatar || "",
      rating: r.rating,
      text: r.comment || r.text || "",
      date: r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "Recently",
      verified: true,
    }));

    // Transform sections to include lectures_list
    const sectionsWithLectures = course.sections.map(section => ({
      ...section.toObject(),
      lectures_list: section.lectures || []
    }));

    // Return course with all data
    const courseObj = course.toObject();
    res.json({
      ...courseObj,
      sections: sectionsWithLectures,
      reviews_list,
      students: courseObj.students || courseObj.studentsEnrolled || 0,
      reviews: courseObj.reviews || courseObj.totalRatings || 0,
    });
  } catch (err) {
    console.error("Get course by ID error:", err);
    res.status(404).json({ message: "Course not found" });
  }
});

// Create course
app.post("/api/courses", protect, instructorOnly, async (req, res) => {
  try {
    const data = sanitizeSections(req.body);
    
    // Sanitize testimonials and gallery
    if (data.imageTestimonials) {
      data.imageTestimonials = sanitizeTestimonials(data.imageTestimonials);
    }
    if (data.videoTestimonials) {
      data.videoTestimonials = sanitizeTestimonials(data.videoTestimonials);
    }
    if (data.projectGallery) {
      data.projectGallery = sanitizeTestimonials(data.projectGallery);
    }
    
    const course = await Course.create({ ...data, instructor: req.user._id });
    res.status(201).json(course);
  } catch (err) {
    console.error("CREATE COURSE ERROR:", err.message);
    res.status(400).json({ message: err.message });
  }
});

// Update course
app.put("/api/courses/:id", protect, instructorOnly, async (req, res) => {
  try {
    const data = sanitizeSections(req.body);
    
    // Sanitize testimonials and gallery
    if (data.imageTestimonials) {
      data.imageTestimonials = sanitizeTestimonials(data.imageTestimonials);
    }
    if (data.videoTestimonials) {
      data.videoTestimonials = sanitizeTestimonials(data.videoTestimonials);
    }
    if (data.projectGallery) {
      data.projectGallery = sanitizeTestimonials(data.projectGallery);
    }
    
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

// Delete course
app.delete("/api/courses/:id", protect, instructorOnly, async (req, res) => {
  try {
    const course = await Course.findOneAndDelete({ _id: req.params.id, instructor: req.user._id });
    if (!course) return res.status(404).json({ message: "Course not found or unauthorized" });
    res.json({ message: "Course deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Toggle publish/unpublish
app.patch("/api/courses/:id/publish", protect, instructorOnly, async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.id, instructor: req.user._id });
    if (!course) return res.status(404).json({ message: "Course not found or unauthorized" });
    course.status = course.status === "published" ? "draft" : "published";
    await course.save();
    res.json({ status: course.status, isPublished: course.status === "published" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Status update (kept for compatibility)
app.patch("/api/courses/:id/status", protect, instructorOnly, async (req, res) => {
  try {
    const course = await Course.findOneAndUpdate(
      { _id: req.params.id, instructor: req.user._id },
      { status: req.body.status },
      { new: true }
    );
    if (!course) return res.status(404).json({ message: "Course not found" });
    res.json(course);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── ENROLLMENT ROUTES ────────────────────────────────────────────────────────

// Get my enrolled courses
app.get("/api/enrollments/my", protect, async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ student: req.user._id })
      .populate({
        path:     "course",
        populate: { path: "instructor", select: "name avatar title" },
      })
      .sort("-createdAt");
    res.json(enrollments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Check if enrolled in a specific course
app.get("/api/enrollments/check/:courseId", protect, async (req, res) => {
  try {
    const enrollment = await Enrollment.findOne({
      student: req.user._id,
      course:  req.params.courseId,
    });
    res.json({ enrolled: Boolean(enrollment), isEnrolled: Boolean(enrollment) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Enroll in a course
app.post("/api/enrollments/:courseId", protect, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ message: "Course not found" });
    if (course.status !== "published" && course.price > 0) {
      return res.status(403).json({ message: "This course is not available for enrollment" });
    }

    const existing = await Enrollment.findOne({
      student: req.user._id,
      course:  req.params.courseId,
    });
    if (existing) return res.status(400).json({ message: "You are already enrolled in this course" });

    const enrollment = await Enrollment.create({
      student: req.user._id,
      course:  req.params.courseId,
    });
    await Course.findByIdAndUpdate(req.params.courseId, { $inc: { studentsEnrolled: 1, students: 1 } });

    // Auto-create empty progress record
    await Progress.findOneAndUpdate(
      { student: req.user._id, courseId: req.params.courseId },
      { $setOnInsert: { student: req.user._id, courseId: req.params.courseId, completedLectures: [] } },
      { upsert: true, new: true }
    );

    res.status(201).json(enrollment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── PROGRESS ROUTES ──────────────────────────────────────────────────────────

// Mark a lecture as complete
app.post("/api/progress/mark", protect, async (req, res) => {
  try {
    const { courseId, lectureId } = req.body;
    if (!courseId || !lectureId) {
      return res.status(400).json({ message: "courseId and lectureId are required" });
    }

    const enrolled = await Enrollment.findOne({ student: req.user._id, course: courseId });
    if (!enrolled) return res.status(403).json({ message: "You are not enrolled in this course" });

    let progress = await Progress.findOne({ student: req.user._id, courseId });
    if (!progress) {
      progress = new Progress({ student: req.user._id, courseId, completedLectures: [] });
    }
    const lecIdStr = String(lectureId);
    if (!progress.completedLectures.includes(lecIdStr)) {
      progress.completedLectures.push(lecIdStr);
    }
    await progress.save();
    res.json(progress);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all progress for current student
app.get("/api/progress/my", protect, async (req, res) => {
  try {
    const progress = await Progress.find({ student: req.user._id });
    res.json(progress);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── REVIEW ROUTES ────────────────────────────────────────────────────────────

// Get reviews for a course (public)
app.get("/api/courses/:courseId/reviews", async (req, res) => {
  try {
    const reviews = await Review.find({ course: req.params.courseId })
      .populate("student", "name avatar")
      .sort("-createdAt")
      .limit(100);

    const mapped = reviews.map(r => ({
      _id:       r._id,
      rating:    r.rating,
      comment:   r.comment || r.text,
      text:      r.comment || r.text,
      createdAt: r.createdAt,
      user:      r.student,
      author:    r.student?.name || "Anonymous",
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ message: "Could not fetch reviews" });
  }
});

// Submit a review (authenticated users only)
app.post("/api/courses/:courseId/reviews", protect, async (req, res) => {
  try {
    const { rating, comment, text } = req.body;
    const reviewText = text || comment || "";
    
    if (!rating) return res.status(400).json({ message: "Rating is required" });

    const existing = await Review.findOne({ course: req.params.courseId, student: req.user._id });
    if (existing) return res.status(400).json({ message: "You have already reviewed this course" });

    const review = await Review.create({
      course:  req.params.courseId,
      student: req.user._id,
      rating:  Number(rating),
      comment: reviewText,
      text:    reviewText,
    });

    const allReviews = await Review.find({ course: req.params.courseId });
    const avg = allReviews.reduce((a, r) => a + r.rating, 0) / allReviews.length;
    await Course.findByIdAndUpdate(req.params.courseId, {
      rating:       Math.round(avg * 10) / 10,
      totalRatings: allReviews.length,
      reviews:      allReviews.length,
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
    if (err.code === 11000) return res.status(400).json({ message: "You have already reviewed this course" });
    res.status(500).json({ message: err.message });
  }
});

// ─── IMAGE UPLOAD: temp disk → Cloudinary uploader.upload() → unlink temp ─────
const UPLOAD_TMP = path.join(__dirname, "uploads", "tmp");
if (!fs.existsSync(UPLOAD_TMP)) fs.mkdirSync(UPLOAD_TMP, { recursive: true });

const tempImageStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_TMP),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".jpg";
    cb(null, `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`);
  },
});
const tempImageUpload = multer({
  storage: tempImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files are allowed (JPG, PNG, WebP, GIF)"), false);
  },
});

app.post("/api/upload/image", protect, instructorOnly, tempImageUpload.single("image"), async (req, res) => {
  console.log('🚀 [POST] /api/upload/image - Request received');
  
  if (!req.file) {
    console.log('⚠️  Upload failed: No file found in request');
    return res.status(400).json({ message: "No file uploaded" });
  }

  const localPath = req.file.path;
  const courseId = req.body.courseId;
  
  console.log(`📂 File detected: ${req.file.originalname} (${req.file.size} bytes)`);
  console.log(`📍 Local temporary path: ${localPath}`);
  console.log(`🆔 Course ID provided: ${courseId || 'None (General Upload)'}`);

  const cleanupLocal = async () => {
    try {
      await fs.promises.unlink(localPath);
      console.log('🧹 Cleanup: Local temporary file deleted');
    } catch (err) {
      console.error('❌ Cleanup Error: Failed to delete local file', err.message);
    }
  };

  try {
    // --- Validation Logic ---
    if (courseId) {
      if (!mongoose.Types.ObjectId.isValid(courseId)) {
        console.log('🚫 Validation Error: Invalid Course ID format');
        await cleanupLocal();
        return res.status(400).json({ message: "Invalid course id" });
      }

      const allowed = await Course.findOne({ _id: courseId, instructor: req.user._id }).select("_id");
      if (!allowed) {
        console.log(`🚫 Auth Error: User ${req.user._id} not authorized for Course ${courseId}`);
        await cleanupLocal();
        return res.status(404).json({ message: "Course not found or unauthorized" });
      }
      console.log('✅ Authorization: Course ownership verified');
    }

    // --- Cloudinary Upload ---
    console.log('☁️  Starting Cloudinary upload...');
    const result = await cloudinary.uploader.upload(localPath, {
      folder: "udemy-clone",
      resource_type: "image",
    });
    console.log('✨ Cloudinary upload successful!');
    console.log(`🔗 URL: ${result.secure_url}`);

    await cleanupLocal();

    // --- Database Update ---
    if (courseId) {
      console.log('💾 Updating database with new thumbnail URL...');
      const updated = await Course.findOneAndUpdate(
        { _id: courseId, instructor: req.user._id },
        { $set: { thumbnail: result.secure_url } },
        { new: true }
      ).select("thumbnail");

      console.log('🏁 Success: Database updated and response sent');
      return res.json({
        url: result.secure_url,
        secure_url: result.secure_url,
        public_id: result.public_id,
        thumbnail: updated.thumbnail,
      });
    }

    console.log('🏁 Success: General upload completed (No DB update required)');
    res.json({
      url: result.secure_url,
      secure_url: result.secure_url,
      public_id: result.public_id,
    });

  } catch (err) {
    console.error('💥 CRITICAL ERROR during upload process:');
    console.error(err);
    await cleanupLocal();
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status:   "ok",
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    time:     new Date().toISOString(),
  });
});

// ─── 404 HANDLER ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} not found` });
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ message: err.message || "Internal server error" });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📦 Database: learnify @ cluster0.27tk541.mongodb.net`);
  console.log(`🌍 CORS allowed origins: ${allowedOrigins.join(", ")}`);
});
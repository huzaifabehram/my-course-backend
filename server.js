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
// NOTE: email sending was removed for now (SMTP isn't set up yet, and the
// nodemailer dependency isn't installed, which was breaking the server
// startup). The "send_email" workflow action and "email_sent" trigger have
// been removed alongside it. To bring email back later: re-add
// `const nodemailer = require("nodemailer");` here, restore emailConfigured
// / getMailer / sendEmailRaw and the "send_email" case in runAction (see
// git history), and re-list "send_email" in WorkflowStepSchema's actionType
// enum and the /admin/workflows/meta actionTypes array.
// NOTE: the Review Importer (Super Admin) originally used the `xlsx`
// package to parse CSV/Excel files, but it wasn't listed in package.json,
// so Render's `npm install` never fetched it and the server crashed on
// require — same issue as nodemailer above. It now parses plain CSV by
// hand instead (see parseCsv() below) — zero dependencies. Excel
// opens/saves .csv files natively, so nothing is actually lost.

const app = express();

// ─── CLOUDINARY CONFIG ────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
console.log("☁️  Cloudinary:", process.env.CLOUDINARY_CLOUD_NAME ? "✓ configured" : "✗ NOT configured — set env vars");

// ─── CORS ─────────────────────────────────────────────────────────────────────
// NEW: this was a strict allowlist of exact URLs — it had no entry for a
// Vercel deployment at all, which is almost certainly what broke courses/
// portals/login: the browser blocks every cross-origin API response before
// your frontend code ever sees it, so static content (served directly by
// Vercel, no CORS involved) still renders while everything that needs the
// backend silently fails. Fixed two ways: (1) any *.vercel.app origin is
// now allowed automatically — Vercel gives every deployment and every PR
// preview its own unique subdomain, so a fixed list can never keep up with
// those; (2) CLIENT_URL/PUBLIC_URL are still supported for your real
// custom domain once DNS points there. Set CLIENT_URL on Render to your
// exact production URL (e.g. https://motiviam.com) as the authoritative
// one either way.
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
    if (!origin || allowedOrigins.includes(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return cb(null, true);
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
  // NEW: tags a workflow (Super Admin → Automation Workflow) can add/remove
  // on a student, used for segmentation in future workflow conditions.
  tags: { type: [String], default: [] },
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

// ══════════════════════════════════════════════════════════════════════════════
// AUTOMATION WORKFLOWS — Super Admin → Automation Workflow
// ══════════════════════════════════════════════════════════════════════════════
// A Workflow has a trigger (a real event on this platform) and an ordered
// list of steps (conditions + actions). See the honest capability notes on
// each trigger/action below — everything not flagged "needs setup" or
// "needs <feature>" fires and executes for real off real data.
const WorkflowStepSchema = new mongoose.Schema({
  type: { type: String, enum: ["condition", "action"], required: true },
  actionType: {
    type: String,
    enum: [
      "create_contact", "add_contact_tag", "remove_contact_tag",
      "assign_user", "remove_assigned_user", "add_note", "internal_notification",
      "notify_student", "wait", "send_whatsapp",
      "add_to_pipeline", "update_opportunity_stage", "webhook",
    ],
  },
  conditionField:    String,
  conditionOperator: { type: String, enum: ["equals", "not_equals", "contains"] },
  conditionValue:    String,
  params: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: true });

// Triggers actually wired to real events (see runWorkflows() call sites):
//   form_submitted, new_sign_up, enrollment_created, payment_received,
//   offer_access_granted, payment_rejected, lesson_started, lesson_completed,
//   category_started, category_completed, newsletter_subscribed,
//   opportunity_created, opportunity_status_changed, link_clicked,
//   whatsapp_sent
// Triggers that fire only once YOU wire something external to call them:
//   customer_replied — needs your SMS/WhatsApp/email provider's inbound
//     webhook pointed at POST /api/inbound/message (see notes below)
// Triggers NOT implemented — no such feature exists on this platform yet,
// so building the trigger without the feature behind it would be fake:
//   video_tracking (needs %-watched tracking — not just done/not-done),
//   customer_booked_appointment / appointment_status_changed (there's no
//   booking/calendar feature anywhere on this platform to trigger from),
//   funnel_website_page_view (would need a tracking call added to every
//   page site-wide — a real but separate project)
// (email_sent was removed along with the send_email action — see the note
// near the top of this file on re-adding email support.)
const WORKFLOW_TRIGGERS = [
  "form_submitted", "new_sign_up", "enrollment_created", "payment_received",
  "offer_access_granted", "payment_rejected", "lesson_started", "lesson_completed",
  "category_started", "category_completed", "newsletter_subscribed",
  "opportunity_created", "opportunity_status_changed", "link_clicked",
  "whatsapp_sent", "customer_replied",
];

const WorkflowSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  trigger:   { type: String, required: true, enum: WORKFLOW_TRIGGERS },
  // NEW: "published" replaces the old "active" naming (still the same
  // boolean underneath) — a published workflow actually runs on its
  // trigger; unpublished sits saved but does nothing.
  published: { type: Boolean, default: false },
  // NEW: optional scoping for triggers that can fire for many different
  // real things — right now just lesson_started/lesson_completed, which
  // otherwise fire for EVERY lesson in EVERY course. When courseId/
  // lectureId are set here, runWorkflows() below only runs this workflow
  // if the real event matches that exact lesson; left empty, it still
  // fires for every lesson, same as before.
  triggerScope: { type: mongoose.Schema.Types.Mixed, default: {} },
  steps:     { type: [WorkflowStepSchema], default: [] },
  runCount:  { type: Number, default: 0 },
  lastRunAt: Date,
}, { timestamps: true });
const Workflow = mongoose.model("Workflow", WorkflowSchema);

const WorkflowRunSchema = new mongoose.Schema({
  workflow:  { type: mongoose.Schema.Types.ObjectId, ref: "Workflow", required: true },
  trigger:   String,
  summary:   String,
  status:    { type: String, enum: ["success", "partial", "failed", "waiting"], default: "success" },
  log:       { type: [String], default: [] },
}, { timestamps: true });
const WorkflowRun = mongoose.model("WorkflowRun", WorkflowRunSchema);

const PendingStepSchema = new mongoose.Schema({
  workflow:   { type: mongoose.Schema.Types.ObjectId, ref: "Workflow", required: true },
  run:        { type: mongoose.Schema.Types.ObjectId, ref: "WorkflowRun", required: true },
  stepIndex:  { type: Number, required: true },
  context:    { type: mongoose.Schema.Types.Mixed, default: {} },
  runAt:      { type: Date, required: true },
}, { timestamps: true });
const PendingStep = mongoose.model("PendingStep", PendingStepSchema);

// In-app notification for a STUDENT (Student Portal bell icon).
const NotificationSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title:   { type: String, default: "" },
  message: { type: String, required: true },
  read:    { type: Boolean, default: false },
}, { timestamps: true });
const Notification = mongoose.model("Notification", NotificationSchema);

// Internal notification for an ADMIN/instructor — distinct from the student
// one above (the "Send Internal Notification" action from your list).
const InternalNotificationSchema = new mongoose.Schema({
  message: { type: String, required: true },
  read:    { type: Boolean, default: false },
}, { timestamps: true });
const InternalNotification = mongoose.model("InternalNotification", InternalNotificationSchema);

// ── CRM: Contact / Opportunity / Pipeline ───────────────────────────────────
// A Contact is the CRM record a workflow's "Create Contact" action produces
// — separate from User, because not every contact (someone who just filled
// the Contact form) is a registered student. `studentId` links the two when
// the same email later registers/enrolls.
const ContactSchema = new mongoose.Schema({
  name:  { type: String, default: "" },
  email: { type: String, lowercase: true, trim: true },
  phone: { type: String, default: "" },
  source: { type: String, default: "" }, // e.g. "Contact Form", "Workflow: Welcome Sequence"
  tags:  { type: [String], default: [] },
  notes: { type: [{ text: String, createdAt: { type: Date, default: Date.now } }], default: [] },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  studentId:  { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });
ContactSchema.index({ email: 1 }, { unique: true, sparse: true });
const Contact = mongoose.model("Contact", ContactSchema);

const PIPELINE_STAGES_DEFAULT = ["New Lead", "Contacted", "Qualified", "Payment Pending", "Customer", "Lost"];

const OpportunitySchema = new mongoose.Schema({
  contact: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
  title:   { type: String, default: "" },
  value:   { type: Number, default: 0 },
  stage:   { type: String, default: PIPELINE_STAGES_DEFAULT[0] },
  status:  { type: String, enum: ["open", "won", "lost"], default: "open" },
}, { timestamps: true });
const Opportunity = mongoose.model("Opportunity", OpportunitySchema);

// A workflow's "Add Link" (in an email/WhatsApp message) is rewritten into
// one of these at send time, so clicking it can be tracked and fire
// link_clicked — see the /l/:code redirect route further down.
const TrackedLinkSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  url:  { type: String, required: true },
  contactEmail: String,
  workflow: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow" },
  clicks: { type: Number, default: 0 },
}, { timestamps: true });
const TrackedLink = mongoose.model("TrackedLink", TrackedLinkSchema);


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
  await seedForms();
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

// ── Package inquiries — from the Services page's Gold/Premium package cards ──
const PackageInquirySchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  whatsapp: { type: String, required: true, trim: true },
  email:    { type: String, required: true, trim: true, lowercase: true },
  package:  { type: String, required: true, enum: ["gold", "premium"] },
  status:   { type: String, enum: ["new", "contacted"], default: "new" },
}, { timestamps: true });
const PackageInquiry = mongoose.model("PackageInquiry", PackageInquirySchema);

// ── Forms registry — Super Admin → Forms ──────────────────────────────────
// A catalog of the real forms already live on the site, so they can be
// named, described, and referenced elsewhere (e.g. scoping the Automation
// Workflow's "Form Submitted" trigger to one specific form via its slug).
// This does NOT dynamically render these forms — the two seeded below are
// real hand-built React forms (EnrolledPage's 2-step enrollment form,
// PackageInquiryPage's Gold/Premium inquiry form); this is a reference
// entry for each, tagged with the same slug those pages already send.
const FormSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  slug:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: "" },
  fields:      { type: [String], default: [] }, // reference only — the real fields live in the page's own code
}, { timestamps: true });
const Form = mongoose.model("Form", FormSchema);

// Seeds the two forms already in use, the first time this runs against a
// fresh database — safe to call every startup (upsert, never duplicates).
async function seedForms() {
  try {
    await Form.findOneAndUpdate(
      { slug: "form-1" },
      { $setOnInsert: { name: "Form 1", slug: "form-1", description: "Course Enrollment — the 2-step form shown when a student enrolls in a course.", fields: ["Name", "Email", "Password", "WhatsApp Number", "Payment Method", "Payment Screenshot"] } },
      { upsert: true }
    );
    await Form.findOneAndUpdate(
      { slug: "form-2" },
      { $setOnInsert: { name: "Form 2", slug: "form-2", description: "Package Inquiry — shown on the Services page's Gold/Premium package cards.", fields: ["Name", "WhatsApp Number", "Email", "Package"] } },
      { upsert: true }
    );
  } catch (err) { console.error("[Forms] seed error:", err.message); }
}

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

// ══════════════════════════════════════════════════════════════════════════════
// AUTOMATION WORKFLOW ENGINE
// ══════════════════════════════════════════════════════════════════════════════
// (Email sending — emailConfigured/getMailer/sendEmailRaw — was removed here
// along with the "send_email" action; see the note near the top of this
// file on bringing it back once SMTP is set up.)

// ── WhatsApp — generic integration against Meta's official WhatsApp Cloud
// API (the standard most providers, including Meta directly, expose this
// exact shape for). Needs WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN
// in .env — see the guide in the chat reply for how to get these.
function whatsappConfigured() {
  return !!(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
}
async function sendWhatsAppRaw({ to, text }) {
  if (!whatsappConfigured()) throw new Error("WhatsApp not configured (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN)");
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: String(to).replace(/[^\d+]/g, ""), // WhatsApp Cloud API wants digits (with country code), no spaces/dashes
      type: "text",
      text: { body: text, preview_url: true },
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `WhatsApp API returned HTTP ${resp.status}`);
  return data;
}

/** Replaces {{field}} in a string with the matching value from the context object. */
function interpolate(str, ctx) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (ctx[key] != null ? String(ctx[key]) : ""));
}

// A message body can carry `[[Label|https://example.com]]` — rewritten here
// into a real tracked link (/l/<code>) so a click can be logged and fire the
// link_clicked trigger. Used by send_whatsapp.
async function rewriteTrackedLinks(text, ctx, workflowId) {
  const linkPattern = /\[\[([^\|\]]+)\|([^\]]+)\]\]/g;
  const matches = [...text.matchAll(linkPattern)];
  let result = text;
  for (const m of matches) {
    const [full, label, url] = m;
    const code = crypto.randomBytes(5).toString("hex");
    await TrackedLink.create({ code, url: url.trim(), contactEmail: ctx.studentEmail || ctx.email || "", workflow: workflowId });
    const trackedUrl = `${process.env.PUBLIC_BASE_URL || ""}/l/${code}`;
    result = result.replace(full, `${label.trim()}: ${trackedUrl}`);
  }
  return result;
}

function conditionMatches(step, ctx) {
  const actual = ctx[step.conditionField];
  const expected = step.conditionValue;
  switch (step.conditionOperator) {
    case "not_equals": return String(actual ?? "") !== String(expected ?? "");
    case "contains":    return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    default:            return String(actual ?? "") === String(expected ?? ""); // "equals"
  }
}

const WAIT_UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000, years: 31536000000 };

/** Runs one action step against the given context. Throws on hard failure; log lines describe what happened either way. */
async function runAction(step, ctx, log, workflowId) {
  const p = step.params || {};

  switch (step.actionType) {
    case "create_contact": {
      const email = interpolate(p.email || "{{studentEmail}}", ctx) || interpolate(p.email || "{{email}}", ctx);
      if (!email) { log.push("create_contact skipped — no email in context"); return; }
      const contact = await Contact.findOneAndUpdate(
        { email },
        {
          $setOnInsert: {
            email, name: interpolate(p.name || "{{studentName}}", ctx) || interpolate("{{name}}", ctx) || "",
            phone: ctx.whatsapp || "", source: p.source || `Workflow: ${ctx.__workflowName || ""}`,
            studentId: ctx.studentId || null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      log.push(`Contact ensured for ${email}`);
      ctx.contactId = contact._id;
      return;
    }
    case "add_contact_tag":
    case "remove_contact_tag": {
      const email = ctx.studentEmail || ctx.email;
      if (!email || !p.tag) { log.push(`${step.actionType} skipped — no contact email/tag`); return; }
      const op = step.actionType === "add_contact_tag" ? { $addToSet: { tags: p.tag } } : { $pull: { tags: p.tag } };
      await Contact.findOneAndUpdate({ email }, op);
      log.push(`${step.actionType === "add_contact_tag" ? "Added" : "Removed"} tag "${p.tag}" on contact ${email}`);
      return;
    }
    case "assign_user":
    case "remove_assigned_user": {
      const email = ctx.studentEmail || ctx.email;
      if (!email) { log.push(`${step.actionType} skipped — no contact email`); return; }
      const assignedTo = step.actionType === "assign_user" ? (p.userId || null) : null;
      await Contact.findOneAndUpdate({ email }, { assignedTo });
      log.push(step.actionType === "assign_user" ? `Assigned contact ${email} to user ${p.userId}` : `Cleared assignment on contact ${email}`);
      return;
    }
    case "add_note": {
      const email = ctx.studentEmail || ctx.email;
      if (!email || !p.text) { log.push("add_note skipped — no contact email/text"); return; }
      await Contact.findOneAndUpdate({ email }, { $push: { notes: { text: interpolate(p.text, ctx) } } });
      log.push(`Note added to contact ${email}`);
      return;
    }
    case "internal_notification": {
      await InternalNotification.create({ message: interpolate(p.message || "", ctx) });
      log.push("Internal notification created for the admin team");
      return;
    }
    case "notify_student": {
      if (!ctx.studentId) { log.push("notify_student skipped — no student in context"); return; }
      await Notification.create({ student: ctx.studentId, title: interpolate(p.title || "", ctx), message: interpolate(p.message || "", ctx) });
      log.push(`Notification created for ${ctx.studentName || ctx.studentId}`);
      return;
    }
    // ("send_email" case removed along with email sending — see the note
    // near the top of this file on bringing it back.)
    case "send_whatsapp": {
      if (!whatsappConfigured()) { log.push("send_whatsapp skipped — WhatsApp API not configured"); return; }
      const to = interpolate(p.to || "{{whatsapp}}", ctx) || interpolate("{{studentPhone}}", ctx);
      if (!to) { log.push("send_whatsapp skipped — no phone number in context"); return; }
      let text = interpolate(p.message || "", ctx);
      text = await rewriteTrackedLinks(text, ctx, workflowId);
      await sendWhatsAppRaw({ to, text });
      log.push(`WhatsApp message sent to ${to}`);
      runWorkflows("whatsapp_sent", { ...ctx, to, __summary: `WhatsApp to ${to}` });
      return;
    }
    case "add_to_pipeline": {
      const email = ctx.studentEmail || ctx.email;
      if (!email) { log.push("add_to_pipeline skipped — no contact email"); return; }
      let contact = await Contact.findOne({ email });
      if (!contact) contact = await Contact.create({ email, name: ctx.studentName || ctx.name || "", studentId: ctx.studentId || null, source: `Workflow: ${ctx.__workflowName || ""}` });
      const stage = p.stage || PIPELINE_STAGES_DEFAULT[0];
      let opp = await Opportunity.findOne({ contact: contact._id, status: "open" });
      const isNew = !opp;
      if (!opp) opp = new Opportunity({ contact: contact._id, title: p.title || ctx.courseTitle || "Opportunity", value: Number(p.value) || ctx.amount || 0, stage });
      else opp.stage = stage;
      await opp.save();
      log.push(`${isNew ? "Created" : "Updated"} pipeline opportunity for ${email} → stage "${stage}"`);
      runWorkflows(isNew ? "opportunity_created" : "opportunity_status_changed", { ...ctx, opportunityId: opp._id, stage, __summary: `${email} → ${stage}` });
      return;
    }
    case "update_opportunity_stage": {
      const email = ctx.studentEmail || ctx.email;
      if (!email || !p.stage) { log.push("update_opportunity_stage skipped — no contact email/stage"); return; }
      const contact = await Contact.findOne({ email });
      if (!contact) { log.push(`update_opportunity_stage skipped — no contact found for ${email}`); return; }
      const opp = await Opportunity.findOneAndUpdate({ contact: contact._id, status: "open" }, { stage: p.stage }, { new: true });
      if (!opp) { log.push(`update_opportunity_stage skipped — no open opportunity for ${email}`); return; }
      log.push(`Opportunity stage for ${email} → "${p.stage}"`);
      runWorkflows("opportunity_status_changed", { ...ctx, opportunityId: opp._id, stage: p.stage, __summary: `${email} → ${p.stage}` });
      return;
    }
    case "webhook": {
      if (!p.url) { log.push("webhook skipped — no URL configured"); return; }
      const resp = await fetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: ctx.__trigger, ...ctx }),
      });
      log.push(`Webhook POSTed to ${p.url} (HTTP ${resp.status})`);
      return;
    }
    default:
      log.push(`Unknown action type "${step.actionType}" — skipped`);
  }
}

/** Executes a workflow's steps starting at `fromIndex`, pausing (via PendingStep) on a wait step. */
async function executeWorkflowSteps(workflow, run, ctx, fromIndex) {
  const log = run.log || [];
  ctx.__workflowName = workflow.name;
  for (let i = fromIndex; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    if (step.type === "condition") {
      if (!conditionMatches(step, ctx)) {
        log.push(`Condition "${step.conditionField} ${step.conditionOperator} ${step.conditionValue}" not met — stopped here`);
        run.status = "partial";
        run.log = log;
        await run.save();
        return;
      }
      log.push(`Condition "${step.conditionField} ${step.conditionOperator} ${step.conditionValue}" matched`);
      continue;
    }
    if (step.actionType === "wait") {
      const amount = Number(step.params?.amount) || 0;
      const unit = step.params?.unit || "minutes";
      const ms = amount * (WAIT_UNIT_MS[unit] || WAIT_UNIT_MS.minutes);
      const runAt = new Date(Date.now() + ms);
      await PendingStep.create({ workflow: workflow._id, run: run._id, stepIndex: i + 1, context: ctx, runAt });
      log.push(`Waiting ${amount} ${unit} — resumes at ${runAt.toISOString()}`);
      run.status = "waiting";
      run.log = log;
      await run.save();
      return;
    }
    try {
      await runAction(step, ctx, log, workflow._id);
    } catch (err) {
      log.push(`Action "${step.actionType}" failed: ${err.message}`);
      run.status = "failed";
      run.log = log;
      await run.save();
      return;
    }
  }
  run.status = run.status === "waiting" ? "success" : (run.status || "success");
  run.log = log;
  await run.save();
}

/** Call this from anywhere a real event happens — fires every published workflow listening for that trigger. Never throws: a broken workflow must not break the request that triggered it. */
// A workflow with a triggerScope only runs for events that match it — e.g.
// a lesson_started workflow scoped to one specific lectureId won't fire for
// every OTHER lesson too. No scope set (the default) means "run for every
// event of this trigger", same as before this existed.
function matchesTriggerScope(workflow, context) {
  const scope = workflow.triggerScope || {};
  if (scope.lectureId && String(context.lectureId || "") !== String(scope.lectureId)) return false;
  if (scope.courseId && String(context.courseId || "") !== String(scope.courseId)) return false;
  if (scope.formSlug && String(context.formSlug || "") !== String(scope.formSlug)) return false;
  return true;
}

async function runWorkflows(trigger, context) {
  try {
    const workflows = await Workflow.find({ trigger, published: true });
    for (const workflow of workflows) {
      if (!matchesTriggerScope(workflow, context)) continue;
      const ctx = { ...context, __trigger: trigger };
      const run = await WorkflowRun.create({ workflow: workflow._id, trigger, summary: context.__summary || "", status: "success", log: [] });
      workflow.runCount = (workflow.runCount || 0) + 1;
      workflow.lastRunAt = new Date();
      await workflow.save();
      await executeWorkflowSteps(workflow, run, ctx, 0);
    }
  } catch (err) {
    console.error("[Automation] runWorkflows error:", err.message);
  }
}

// Poller — resumes any workflow run paused on a wait step once it's due.
// Dependency-free (no job queue needed): just checks every minute.
setInterval(async () => {
  try {
    const due = await PendingStep.find({ runAt: { $lte: new Date() } }).limit(50);
    for (const pending of due) {
      const workflow = await Workflow.findById(pending.workflow);
      const run = await WorkflowRun.findById(pending.run);
      await PendingStep.findByIdAndDelete(pending._id);
      if (!workflow || !run || !workflow.published) continue;
      run.status = "success";
      await executeWorkflowSteps(workflow, run, pending.context, pending.stepIndex);
    }
  } catch (err) {
    console.error("[Automation] poller error:", err.message);
  }
}, 60 * 1000);

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
    runWorkflows("new_sign_up", {
      studentId: user._id, studentName: user.name, studentEmail: user.email,
      __summary: user.name,
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

// NEW: real enrolled-student list for one of an instructor's own courses —
// backs the Instructor Portal's new "Students" tab. Only ever returns data
// for a course this instructor actually owns.
app.get("/api/instructor/courses/:id/students", protect, instructorOnly, async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.id, instructor: req.user._id }).select("title sections");
    if (!course) return res.status(404).json({ message: "Course not found" });
    const totalLectures = (course.sections || []).reduce((a, s) => a + (s.lectures?.length || 0), 0);

    const enrollments = await Enrollment.find({ course: course._id, paymentStatus: "verified" })
      .populate("student", "name email avatar")
      .sort("-createdAt");

    const progressDocs = await Progress.find({ courseId: course._id, student: { $in: enrollments.map((e) => e.student?._id) } });
    const progressByStudent = {};
    progressDocs.forEach((p) => { progressByStudent[String(p.student)] = p.completedLectures?.length || 0; });

    const students = enrollments.filter((e) => e.student).map((e) => {
      const done = progressByStudent[String(e.student._id)] || 0;
      return {
        studentId: e.student._id,
        name: e.student.name,
        email: e.student.email,
        avatar: e.student.avatar || "",
        enrolledAt: e.createdAt,
        completedLectures: done,
        totalLectures,
        completionPct: totalLectures > 0 ? Math.round((done / totalLectures) * 100) : 0,
      };
    });

    res.json({ courseTitle: course.title, totalLectures, students });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// NEW: real reviews for one of an instructor's own courses — backs the
// Instructor Portal's new "Reviews" tab. Reads from the exact same Review
// collection the course's public landing page shows and that the Super
// Admin's Review Importer (CSV) writes into — so anything imported there,
// or left by a real student, shows up here identically.
app.get("/api/instructor/courses/:id/reviews", protect, instructorOnly, async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.id, instructor: req.user._id }).select("title");
    if (!course) return res.status(404).json({ message: "Course not found" });
    const reviews = await Review.find({ course: course._id }).sort("-createdAt");
    res.json({ courseTitle: course.title, reviews });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// NEW: real notifications for the Instructor Portal's bell icon — the most
// recent verified enrollments across all of this instructor's courses.
app.get("/api/instructor/notifications", protect, instructorOnly, async (req, res) => {
  try {
    const myCourses = await Course.find({ instructor: req.user._id }).select("_id title");
    const courseIds = myCourses.map((c) => c._id);
    const courseTitleById = {};
    myCourses.forEach((c) => { courseTitleById[String(c._id)] = c.title; });

    const enrollments = await Enrollment.find({ course: { $in: courseIds }, paymentStatus: "verified" })
      .populate("student", "name")
      .sort("-createdAt")
      .limit(20);

    const notifications = enrollments.filter((e) => e.student).map((e) => ({
      id: e._id,
      message: `${e.student.name} enrolled in "${courseTitleById[String(e.course)] || "your course"}"`,
      createdAt: e.createdAt,
    }));

    res.json(notifications);
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
      // Snapshot of what the student was shown at checkout. FIX: this used
      // to multiply by 280 to convert an assumed-USD price to PKR — but
      // course.price is already stored in PKR (same root cause as the
      // frontend price bugs fixed earlier), so every enrollment's recorded
      // amount was 280x too high, which is what the Super Admin
      // verification queue was displaying.
      amount:   Math.round(course.price || 0),
      currency: "PKR",
    });

    runWorkflows("enrollment_created", {
      studentId: req.user._id, studentName: req.user.name, studentEmail: req.user.email,
      courseId: course._id, courseTitle: course.title, amount: enrollment.amount, category: course.category,
      __summary: `${req.user.name} → ${course.title}`,
    });
    // "Form Submitted", tagged formSlug: "form-1" — the 2-step course
    // enrollment form is registered as "Form 1" in Super Admin → Forms, so
    // a workflow can be scoped to react to this specific form instead of
    // every form on the site.
    runWorkflows("form_submitted", {
      name: req.user.name, email: req.user.email, message: `Enrolled in ${course.title}`, formSlug: "form-1",
      __summary: `${req.user.name} → ${course.title}`,
    });
    // "Category Started" — same event, filtered/labeled by the course's
    // category, for workflows that only care about e.g. "Marketing" courses.
    runWorkflows("category_started", {
      studentId: req.user._id, studentName: req.user.name, studentEmail: req.user.email,
      courseId: course._id, courseTitle: course.title, category: course.category,
      __summary: `${req.user.name} started ${course.category || "a"} category`,
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

    const verifyCtx = {
      studentId: populated.student?._id, studentName: populated.student?.name, studentEmail: populated.student?.email,
      courseId: populated.course?._id, courseTitle: populated.course?.title,
      __summary: `${populated.student?.name} → ${populated.course?.title}`,
    };
    runWorkflows("payment_received", verifyCtx);
    // "Offer Access Granted" — fires alongside payment_received on this
    // platform, since access is granted at the moment payment is verified.
    runWorkflows("offer_access_granted", verifyCtx);

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

    runWorkflows("payment_rejected", {
      studentId: enrollment.student?._id, studentName: enrollment.student?.name, studentEmail: enrollment.student?.email,
      courseId: enrollment.course?._id, courseTitle: enrollment.course?.title, reason: enrollment.rejectionReason,
      __summary: `${enrollment.student?.name} → ${enrollment.course?.title}`,
    });

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

// NEW: "Lesson Started" trigger — fires the first time a student opens a
// lecture (not necessarily finishes it), called from the Student Portal's
// video player when a lecture is opened. Doesn't touch Progress/completion
// at all — purely fires the trigger.
app.post("/api/progress/lesson-started", protect, async (req, res) => {
  try {
    const { courseId, lectureId, lectureTitle } = req.body || {};
    if (!courseId || !lectureId) return res.status(400).json({ message: "courseId and lectureId are required" });
    const course = await Course.findById(courseId).select("title category");
    runWorkflows("lesson_started", {
      studentId: req.user._id, studentName: req.user.name, studentEmail: req.user.email,
      courseId, courseTitle: course?.title, lectureId: String(lectureId), lectureTitle: lectureTitle || "",
      category: course?.category,
      __summary: `${req.user.name} started "${lectureTitle || lectureId}"`,
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/progress/mark", protect, async (req, res) => {
  try {
    const { courseId, lectureId } = req.body;
    if (!courseId || !lectureId) return res.status(400).json({ message: "courseId and lectureId are required" });
    if (!(await Enrollment.findOne({ student: req.user._id, course: courseId })))
      return res.status(403).json({ message: "Not enrolled in this course" });

    let progress = await Progress.findOne({ student: req.user._id, courseId });
    if (!progress) progress = new Progress({ student: req.user._id, courseId, completedLectures: [] });
    const lid = String(lectureId);
    const wasAlreadyDone = progress.completedLectures.includes(lid);
    if (!wasAlreadyDone) progress.completedLectures.push(lid);
    await progress.save();

    if (!wasAlreadyDone) {
      const course = await Course.findById(courseId).select("title sections category");
      const totalLectures = (course?.sections || []).reduce((a, s) => a + (s.lectures?.length || 0), 0);
      const baseCtx = {
        studentId: req.user._id, studentName: req.user.name, studentEmail: req.user.email,
        courseId, courseTitle: course?.title, lectureId: lid, category: course?.category,
      };
      runWorkflows("lesson_completed", { ...baseCtx, __summary: `${req.user.name} → ${course?.title}` });
      if (totalLectures > 0 && progress.completedLectures.length >= totalLectures) {
        // "Category Completed" — same event as course completion, labeled
        // by the course's category so a workflow can target e.g. everyone
        // who finishes any "E-Commerce" course.
        runWorkflows("category_completed", { ...baseCtx, __summary: `${req.user.name} completed ${course?.title}` });
      }
    }

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

// Aggregate — every note this student has across every course, for the
// sidebar-level "Notes" tab (as opposed to /api/notes/:courseId, used
// inside one course's player).
app.get("/api/notes/my", protect, async (req, res) => {
  try {
    const notes = await Note.find({ student: req.user._id }).sort("-createdAt");
    res.json(notes);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

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

// Aggregate — Q&A across every course this student is verified-enrolled in,
// for the sidebar-level "Q&A" tab.
app.get("/api/questions/my-courses", protect, async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ student: req.user._id, paymentStatus: "verified" }).select("course");
    const courseIds = enrollments.map((e) => e.course);
    const questions = await Question.find({ courseId: { $in: courseIds } })
      .populate("author", "name avatar")
      .populate("answers.author", "name avatar")
      .sort("-createdAt");
    res.json(questions);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

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

// Used by the Review Importer (Super Admin) — CSV only (see the NOTE up top
// on why Excel/.xlsx isn't parsed directly anymore: Excel opens/saves .csv
// files fine, so this loses nothing practical).
const spreadsheetMulter = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },            // 5 MB — plenty for a review sheet
  fileFilter: (_, file, cb) => {
    const ok = ["text/csv", "application/csv"];
    // Some browsers send CSV as text/plain or octet-stream — fall back to
    // checking the file extension so a real CSV isn't rejected on mimetype
    // alone.
    const okExt = /\.csv$/i.test(file.originalname || "");
    (ok.includes(file.mimetype) || okExt) ? cb(null, true) : cb(new Error("Only CSV files are allowed"));
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
    runWorkflows("form_submitted", { name: submission.name, email: submission.email, message: submission.message, __summary: submission.name });
    res.status(201).json(submission);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Super Admin — list Contact Us submissions.
app.get("/api/admin/contact-submissions", protect, adminOnly, async (req, res) => {
  try {
    res.json(await ContactSubmission.find({}).sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Public — Services page's Gold/Premium package inquiry form.
app.post("/api/package-inquiries", async (req, res) => {
  try {
    const { name, whatsapp, email, package: pkg } = req.body || {};
    if (!name?.trim() || !whatsapp?.trim() || !email?.trim())
      return res.status(400).json({ message: "Name, WhatsApp number, and email are required." });
    if (!["gold", "premium"].includes(pkg))
      return res.status(400).json({ message: "Please choose a package." });
    const inquiry = await PackageInquiry.create({
      name: name.trim(), whatsapp: whatsapp.trim(), email: email.trim().toLowerCase(), package: pkg,
    });
    runWorkflows("form_submitted", { name: inquiry.name, email: inquiry.email, message: `${pkg === "gold" ? "Gold" : "Premium"} Package inquiry`, formSlug: "form-2", __summary: `${inquiry.name} — ${pkg} package` });
    res.status(201).json(inquiry);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Super Admin — list package inquiries.
app.get("/api/admin/package-inquiries", protect, adminOnly, async (req, res) => {
  try {
    res.json(await PackageInquiry.find({}).sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// FORMS — Super Admin → Forms
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/admin/forms", protect, adminOnly, async (req, res) => {
  try {
    res.json(await Form.find({}).sort("slug"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/forms", protect, adminOnly, async (req, res) => {
  try {
    const { name, slug, description, fields } = req.body || {};
    if (!name?.trim() || !slug?.trim()) return res.status(400).json({ message: "Name and slug are required" });
    const form = await Form.create({
      name: name.trim(), slug: slug.trim().toLowerCase().replace(/\s+/g, "-"),
      description: description || "", fields: Array.isArray(fields) ? fields : [],
    });
    res.status(201).json(form);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: "A form with that slug already exists" });
    res.status(500).json({ message: err.message });
  }
});

app.put("/api/admin/forms/:id", protect, adminOnly, async (req, res) => {
  try {
    const { name, description, fields } = req.body || {};
    // slug is intentionally not editable here — it's what live pages/
    // triggers already reference, so changing it would silently break them.
    const update = {};
    if (name !== undefined) update.name = name.trim();
    if (description !== undefined) update.description = description;
    if (fields !== undefined) update.fields = Array.isArray(fields) ? fields : [];
    const form = await Form.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!form) return res.status(404).json({ message: "Form not found" });
    res.json(form);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete("/api/admin/forms/:id", protect, adminOnly, async (req, res) => {
  try {
    const form = await Form.findById(req.params.id);
    if (!form) return res.status(404).json({ message: "Form not found" });
    if (form.slug === "form-1" || form.slug === "form-2")
      return res.status(400).json({ message: "This form is wired into a live page and can't be deleted from here." });
    await Form.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
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
    runWorkflows("newsletter_subscribed", { email: clean, __summary: clean });
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
// REVIEW IMPORTER — Super Admin → Review Importer
// ══════════════════════════════════════════════════════════════════════════════
// Bulk-adds reviews to a course's real review list (the same Review
// collection/format every review on that course's landing page already
// comes from) via a CSV upload — columns: Student Name, Date, Stars, Review.

// Parses CSV text into an array of row objects keyed by header, handling
// quoted fields (so a review containing a comma or a quote doesn't break
// the columns) — a small hand-written parser instead of a library, so this
// route has zero npm dependencies.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      // skip — \r\n line endings are handled by the following \n
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) pushRow();

  const filtered = rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  if (filtered.length === 0) return [];
  const headers = filtered[0].map((h) => h.trim());
  return filtered.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] ?? ""; });
    return obj;
  });
}

const REVIEW_IMPORT_HEADERS = ["Student Name", "Date", "Stars", "Review"];
const REVIEW_IMPORT_SAMPLE_ROW = ["Ayesha Siddiqui", "2026-03-15", "5", "Excellent course, learned so much about running paid ads properly."];

// Sample template — downloadable from the Review Importer page so the
// admin knows exactly which columns/format to fill in. Excel opens and
// saves .csv files natively, so this works as the "Excel sample" too.
app.get("/api/admin/reviews-template.csv", protect, adminOnly, (req, res) => {
  const rows = [REVIEW_IMPORT_HEADERS, REVIEW_IMPORT_SAMPLE_ROW];
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=review-import-sample.csv");
  res.send(csv);
});

// Existing reviews for one course — shown on the Review Importer page so an
// admin can see what's already there (and remove a bad import).
app.get("/api/admin/courses/:id/reviews", protect, adminOnly, async (req, res) => {
  try {
    res.json(await Review.find({ course: req.params.id }).sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete("/api/admin/reviews/:id", protect, adminOnly, async (req, res) => {
  try {
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ message: "Review not found" });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/courses/:id/reviews/import", protect, adminOnly, spreadsheetMulter.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const course = await Course.findById(req.params.id).select("_id");
    if (!course) return res.status(404).json({ message: "Course not found" });

    let rows;
    try {
      rows = parseCsv(req.file.buffer.toString("utf8"));
    } catch (parseErr) {
      return res.status(400).json({ message: "Couldn't read that file — make sure it's a valid CSV file." });
    }

    // Column names are matched loosely (case/space-insensitive) so "Student
    // Name", "student_name", "Name" etc. all work, rather than forcing an
    // exact header match.
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
    const getCell = (row, ...aliases) => {
      const keys = Object.keys(row);
      for (const alias of aliases) {
        const key = keys.find((k) => norm(k) === norm(alias));
        if (key !== undefined) return row[key];
      }
      return "";
    };

    const toCreate = [];
    const errors = [];
    rows.forEach((row, i) => {
      const lineNo = i + 2; // +1 for header row, +1 for 1-indexing
      const name = String(getCell(row, "Student Name", "Name", "Author")).trim();
      const dateRaw = getCell(row, "Date");
      const starsRaw = getCell(row, "Stars", "Rating", "Star");
      const text = String(getCell(row, "Review", "Comment", "Text")).trim();

      const stars = Number(starsRaw);
      if (!name) { errors.push(`Row ${lineNo}: missing Student Name`); return; }
      if (!stars || stars < 1 || stars > 5) { errors.push(`Row ${lineNo}: Stars must be a number 1–5 (got "${starsRaw}")`); return; }
      if (!text) { errors.push(`Row ${lineNo}: missing Review text`); return; }

      let createdAt = new Date();
      if (dateRaw) {
        const parsed = new Date(dateRaw);
        if (!isNaN(parsed.getTime())) createdAt = parsed;
      }

      toCreate.push({ course: course._id, authorName: name, rating: stars, comment: text, text, createdAt });
    });

    if (toCreate.length > 0) await Review.insertMany(toCreate);

    res.json({ imported: toCreate.length, skipped: errors.length, errors: errors.slice(0, 20) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTOMATION WORKFLOW ROUTES — Super Admin → Automation Workflow
// ══════════════════════════════════════════════════════════════════════════════

// List available triggers/action types + whether email/WhatsApp are
// configured, so the builder UI can render its dropdowns and warn if a
// channel isn't set up yet.
app.get("/api/admin/workflows/meta", protect, adminOnly, async (req, res) => {
  res.json({
    triggers: WORKFLOW_TRIGGERS,
    actionTypes: [
      "create_contact", "add_contact_tag", "remove_contact_tag",
      "assign_user", "remove_assigned_user", "add_note", "internal_notification",
      "notify_student", "wait", "send_whatsapp",
      "add_to_pipeline", "update_opportunity_stage", "webhook",
    ],
    whatsappConfigured: whatsappConfigured(),
    pipelineStages: PIPELINE_STAGES_DEFAULT,
  });
});

app.get("/api/admin/workflows", protect, adminOnly, async (req, res) => {
  try {
    res.json(await Workflow.find({}).sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Single workflow — the full-page editor loads this directly by ID.
app.get("/api/admin/workflows/:id", protect, adminOnly, async (req, res) => {
  try {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ message: "Workflow not found" });
    res.json(workflow);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/workflows", protect, adminOnly, async (req, res) => {
  try {
    const { name, trigger, steps, published, triggerScope } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ message: "Name is required" });
    if (!WORKFLOW_TRIGGERS.includes(trigger)) return res.status(400).json({ message: "Invalid trigger" });
    const workflow = await Workflow.create({
      name: name.trim(), trigger, steps: Array.isArray(steps) ? steps : [], published: published === true,
      triggerScope: triggerScope && typeof triggerScope === "object" ? triggerScope : {},
    });
    res.status(201).json(workflow);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put("/api/admin/workflows/:id", protect, adminOnly, async (req, res) => {
  try {
    const { name, trigger, steps, published, triggerScope } = req.body || {};
    const update = {};
    if (name !== undefined)    update.name = name.trim();
    if (trigger !== undefined) {
      if (!WORKFLOW_TRIGGERS.includes(trigger)) return res.status(400).json({ message: "Invalid trigger" });
      update.trigger = trigger;
    }
    if (steps !== undefined)     update.steps = steps;
    if (published !== undefined) update.published = published;
    if (triggerScope !== undefined) update.triggerScope = triggerScope && typeof triggerScope === "object" ? triggerScope : {};
    const workflow = await Workflow.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!workflow) return res.status(404).json({ message: "Workflow not found" });
    res.json(workflow);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete("/api/admin/workflows/:id", protect, adminOnly, async (req, res) => {
  try {
    const workflow = await Workflow.findByIdAndDelete(req.params.id);
    if (!workflow) return res.status(404).json({ message: "Workflow not found" });
    await PendingStep.deleteMany({ workflow: workflow._id });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Run history for one workflow — proof it's actually executing, with a
// step-by-step log for each run.
app.get("/api/admin/workflows/:id/runs", protect, adminOnly, async (req, res) => {
  try {
    res.json(await WorkflowRun.find({ workflow: req.params.id }).sort("-createdAt").limit(50));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Manual "Test Run" — fires the workflow immediately with sample/blank
// context, so an admin can confirm it runs without waiting for a real event.
app.post("/api/admin/workflows/:id/test", protect, adminOnly, async (req, res) => {
  try {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ message: "Workflow not found" });
    const testCtx = {
      studentId: req.user._id, studentName: req.user.name, studentEmail: req.user.email,
      courseId: "", courseTitle: "Sample Course", amount: 0, lectureId: "", reason: "Sample reason",
      name: req.user.name, email: req.user.email, message: "Sample message", category: "Sample Category",
      whatsapp: req.user.phone || "",
      __trigger: workflow.trigger, __summary: `Test run by ${req.user.name}`,
    };
    const run = await WorkflowRun.create({ workflow: workflow._id, trigger: workflow.trigger, summary: `Test run by ${req.user.name}`, status: "success", log: [] });
    workflow.runCount = (workflow.runCount || 0) + 1;
    workflow.lastRunAt = new Date();
    await workflow.save();
    await executeWorkflowSteps(workflow, run, testCtx, 0);
    res.json(await WorkflowRun.findById(run._id));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// CRM: CONTACTS + PIPELINE (OPPORTUNITIES) — Super Admin → Pipeline
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/admin/contacts", protect, adminOnly, async (req, res) => {
  try {
    res.json(await Contact.find({}).populate("assignedTo", "name email").sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// CSV export of contacts.
app.get("/api/admin/contacts/export.csv", protect, adminOnly, async (req, res) => {
  try {
    const contacts = await Contact.find({}).sort("-createdAt");
    const rows = [["Name", "Email", "Phone", "Tags", "Source", "Created"]];
    for (const c of contacts) rows.push([c.name, c.email, c.phone, (c.tags || []).join("; "), c.source, c.createdAt.toISOString()]);
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=contacts.csv");
    res.send(csv);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/opportunities", protect, adminOnly, async (req, res) => {
  try {
    res.json(await Opportunity.find({}).populate("contact").sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// CSV export of opportunities (the Pipeline board).
app.get("/api/admin/opportunities/export.csv", protect, adminOnly, async (req, res) => {
  try {
    const opps = await Opportunity.find({}).populate("contact").sort("-createdAt");
    const rows = [["Contact", "Email", "Title", "Value", "Stage", "Status", "Created"]];
    for (const o of opps) rows.push([o.contact?.name, o.contact?.email, o.title, o.value, o.stage, o.status, o.createdAt.toISOString()]);
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=opportunities.csv");
    res.send(csv);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Manually move a card between pipeline stages — also fires
// opportunity_status_changed, same as a workflow doing it, so everything
// stays interlinked either way.
app.patch("/api/admin/opportunities/:id/stage", protect, adminOnly, async (req, res) => {
  try {
    const { stage } = req.body || {};
    if (!stage) return res.status(400).json({ message: "stage is required" });
    const opp = await Opportunity.findByIdAndUpdate(req.params.id, { stage }, { new: true }).populate("contact");
    if (!opp) return res.status(404).json({ message: "Opportunity not found" });
    runWorkflows("opportunity_status_changed", {
      studentEmail: opp.contact?.email, studentName: opp.contact?.name, stage,
      opportunityId: opp._id, __summary: `${opp.contact?.email} → ${stage}`,
    });
    res.json(opp);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.patch("/api/admin/contacts/:id/assign", protect, adminOnly, async (req, res) => {
  try {
    const { userId } = req.body || {};
    const contact = await Contact.findByIdAndUpdate(req.params.id, { assignedTo: userId || null }, { new: true }).populate("assignedTo", "name email");
    if (!contact) return res.status(404).json({ message: "Contact not found" });
    res.json(contact);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/contacts/:id/notes", protect, adminOnly, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ message: "Note text is required" });
    const contact = await Contact.findByIdAndUpdate(req.params.id, { $push: { notes: { text: text.trim() } } }, { new: true });
    if (!contact) return res.status(404).json({ message: "Contact not found" });
    res.json(contact);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// People an admin can assign a contact to (the "Assign User" action) —
// admins and instructors.
app.get("/api/admin/assignable-users", protect, adminOnly, async (req, res) => {
  try {
    res.json(await User.find({ role: { $in: ["admin", "instructor"] } }).select("name email role"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// LINK TRACKING — "Link Clicked" trigger
// ══════════════════════════════════════════════════════════════════════════════
// A message body's [[Label|https://example.com]] gets rewritten into one of
// these at send time (see rewriteTrackedLinks above). Visiting it logs the
// click, fires link_clicked, then redirects to the real destination.
app.get("/l/:code", async (req, res) => {
  try {
    const link = await TrackedLink.findOneAndUpdate({ code: req.params.code }, { $inc: { clicks: 1 } }, { new: true });
    if (!link) return res.status(404).send("Link not found");
    runWorkflows("link_clicked", {
      studentEmail: link.contactEmail, url: link.url,
      __summary: `Clicked: ${link.url}`,
    });
    res.redirect(link.url);
  } catch (err) { res.status(500).send("Something went wrong"); }
});

// ══════════════════════════════════════════════════════════════════════════════
// INBOUND MESSAGES — "Customer Replied" trigger
// ══════════════════════════════════════════════════════════════════════════════
// NOT automatic — this only fires when YOUR SMS/WhatsApp/email provider's
// inbound webhook is configured to POST here. Point your provider's
// "incoming message" webhook at POST /api/inbound/message with
// { "from": "<phone or email>", "text": "<message body>" } and this trigger
// starts firing for real. Left unauthenticated since providers can't send
// your app's login token — if you want it locked down, add a shared-secret
// header check here matching a value only you and your provider know.
app.post("/api/inbound/message", async (req, res) => {
  try {
    const { from, text } = req.body || {};
    if (!from) return res.status(400).json({ message: "from is required" });
    const contact = await Contact.findOne({ $or: [{ email: from }, { phone: from }] });
    runWorkflows("customer_replied", {
      studentEmail: contact?.email || from, studentName: contact?.name || "", message: text || "",
      __summary: `Reply from ${from}`,
    });
    res.json({ received: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS — Student Portal bell icon (created by the "notify" workflow action)
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/notifications/my", protect, async (req, res) => {
  try {
    res.json(await Notification.find({ student: req.user._id }).sort("-createdAt").limit(50));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.patch("/api/notifications/:id/read", protect, async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate({ _id: req.params.id, student: req.user._id }, { read: true }, { new: true });
    if (!notif) return res.status(404).json({ message: "Notification not found" });
    res.json(notif);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Internal (admin-facing) notifications, created by the "Send Internal
// Notification" workflow action. No bell icon wired to this yet in the
// Super Admin panel — these are ready to list whenever that's added.
app.get("/api/admin/internal-notifications", protect, adminOnly, async (req, res) => {
  try {
    res.json(await InternalNotification.find({}).sort("-createdAt").limit(50));
  } catch (err) { res.status(500).json({ message: err.message }); }
});
app.patch("/api/admin/internal-notifications/:id/read", protect, adminOnly, async (req, res) => {
  try {
    const notif = await InternalNotification.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
    if (!notif) return res.status(404).json({ message: "Notification not found" });
    res.json(notif);
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
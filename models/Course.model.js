// server/models/Course.model.js
const mongoose = require("mongoose");

const LectureSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, enum: ["video", "pdf", "audio", "quiz"], default: "video" },
  duration: { type: String, default: "" },
  videoUrl: { type: String, default: "" },
  free: { type: Boolean, default: false },
});

const SectionSchema = new mongoose.Schema({
  title: { type: String, required: true },
  lectures: [LectureSchema],
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX: Add `_id: false` to prevent automatic _id generation
// OR explicitly allow `id` field in schema
// ═══════════════════════════════════════════════════════════════════════════

const ImageTestimonialSchema = new mongoose.Schema({
  author: { type: String, default: "" },
  text: { type: String, default: "" },
  imageUrl: { type: String, default: "" },
}, { _id: true }); // Allow MongoDB to generate _id automatically

const VideoTestimonialSchema = new mongoose.Schema({
  author: { type: String, default: "" },
  text: { type: String, default: "" },
  videoUrl: { type: String, default: "" },
}, { _id: true }); // Allow MongoDB to generate _id automatically

const ProjectGallerySchema = new mongoose.Schema({
  imageUrl: { type: String, required: true },
  caption: { type: String, default: "" },
}, { _id: true }); // Allow MongoDB to generate _id automatically

const CourseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Course title is required"],
      trim: true,
    },
    subtitle: {
      type: String,
      default: "",
    },
    description: {
      type: String,
      default: "",
    },
    category: {
      type: String,
      default: "General",
    },
    price: {
      type: Number,
      required: true,
      default: 0,
    },
    discountPrice: {
      type: Number,
      default: 0,
    },
    thumbnail: {
      type: String,
      default: "",
    },
    previewVideoUrl: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["draft", "published", "review"],
      default: "draft",
    },
    instructor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sections: [SectionSchema],

    // Course content
    whatYouLearn: {
      type: [String],
      default: [],
    },
    requirements: {
      type: [String],
      default: [],
    },
    tags: {
      type: [String],
      default: [],
    },

    // Stats
    studentsEnrolled: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
    level: {
      type: String,
      enum: ["Beginner", "Intermediate", "Advanced"],
      default: "Beginner",
    },
    language: {
      type: String,
      default: "English",
    },
    duration: {
      type: String,
      default: "",
    },

    // ═══════════════════════════════════════════════════════════════════════
    // FIXED: Use proper subdocument schemas
    // ═══════════════════════════════════════════════════════════════════════
    
    imageTestimonials: {
      type: [ImageTestimonialSchema],
      default: [],
    },

    videoTestimonials: {
      type: [VideoTestimonialSchema],
      default: [],
    },

    projectGallery: {
      type: [ProjectGallerySchema],
      default: [],
    },

    // Students Also Bought (references to other courses)
    alsoBoughtCourseIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Course",
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Course", CourseSchema);